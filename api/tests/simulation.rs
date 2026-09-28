use mostro_community_api::{
    config::{BondApply, Community, Configuration, Market, Nostr, PaymentMethod, Safety},
    simulation::{self, Actor, SimulationScenario},
};

fn sample_config() -> Configuration {
    Configuration {
        community: Community {
            name: "Comunidad Regtest".into(),
            about: "Comunidad de prueba para simulación P2P".into(),
            website: "https://comunidad.test".into(),
            contact: "https://t.me/mostro_test".into(),
            language: "es".into(),
        },
        market: Market {
            fiat_currencies: vec!["EUR".into()],
            min_trade_sats: 10_000,
            max_trade_sats: 1_000_000,
            fee_bps: 60, // 0.6%
            dev_fee_bps: 0,
            max_routing_fee_bps: 10,
        },
        safety: Safety {
            bond_enabled: true,
            bond_bps: 300,         // 3.0%
            base_bond_sats: 1_000, // 1000 sats base
            bond_apply_to: BondApply::Both,
            automatic_timeout_slash: true,
            pow: 0,
            pow_first_contact: 0,
        },
        nostr: Nostr {
            relays: vec!["wss://relay.damus.io".into()],
        },
        payment_methods: vec![PaymentMethod {
            id: "sepa".into(),
            label: "SEPA Instant".into(),
            category: "bank".into(),
            active: true,
        }],
    }
}

#[test]
fn happy_path_simulation_calculates_exact_bonds_and_settlement() {
    let config = sample_config();
    let report = simulation::run_simulation(
        &config,
        Some("npub1qqdagara05n9ahlrh5ah9xvgv9r2mpgd2yy4lemmwc7ryq2kskuswt0t3x"),
        SimulationScenario::HappyPath,
        Some(50_000),
    )
    .expect("Simulación falló");

    assert_eq!(report.scenario, SimulationScenario::HappyPath);
    assert_eq!(report.final_status, "success");
    assert!(report.is_success);

    // 50,000 sats * 0.6% = 300 sats fee
    assert_eq!(report.financials.total_mostro_fee_sats, 300);
    assert_eq!(report.financials.fee_per_side_sats, 150);

    // 1000 base + 50,000 * 3.0% (1500) = 2500 sats bond
    assert_eq!(report.financials.seller_bond_sats, 2500);
    assert_eq!(report.financials.buyer_bond_sats, 2500);

    // Seller locked: 50,000 + 2500 bond + 150 fee = 52,650 sats
    assert_eq!(report.financials.seller_total_locked_sats, 52_650);

    // Buyer locked: 2500 bond + 150 fee = 2650 sats
    assert_eq!(report.financials.buyer_total_locked_sats, 2650);

    assert_eq!(report.steps.len(), 9); // 9 steps in happy path
    assert_eq!(report.steps.first().unwrap().actor, Actor::Seller);
    assert_eq!(report.steps.last().unwrap().actor, Actor::Mostro);
    assert_eq!(report.steps.last().unwrap().order_status, "success");
}

#[test]
fn dispute_scenarios_execute_solver_resolutions_faithfully() {
    let config = sample_config();

    // Fallo a favor del comprador
    let buyer_favored = simulation::run_simulation(
        &config,
        None,
        SimulationScenario::DisputeSettledForBuyer,
        Some(20_000),
    )
    .expect("Simulación fallo comprador falló");

    assert_eq!(buyer_favored.final_status, "success_dispute_resolved");
    assert!(buyer_favored.steps.iter().any(|s| s.actor == Actor::Solver));
    assert!(
        buyer_favored
            .steps
            .iter()
            .any(|s| s.order_status == "dispute")
    );

    // Fallo a favor del vendedor
    let seller_favored = simulation::run_simulation(
        &config,
        None,
        SimulationScenario::DisputeRefundedToSeller,
        Some(20_000),
    )
    .expect("Simulación fallo vendedor falló");

    assert_eq!(seller_favored.final_status, "refunded_to_seller");
    assert!(
        seller_favored
            .steps
            .iter()
            .any(|s| !s.action_code.is_empty() || s.actor == Actor::Solver)
    );
}

#[test]
fn seller_cancellation_cancels_hold_invoice_without_penalties() {
    let config = sample_config();
    let report = simulation::run_simulation(
        &config,
        None,
        SimulationScenario::SellerCancellation,
        Some(30_000),
    )
    .expect("Simulación cancelación falló");

    assert_eq!(report.final_status, "canceled");
    assert_eq!(report.steps.len(), 4);
    let cancel_step = report.steps.last().unwrap();
    assert_eq!(cancel_step.order_status, "canceled");
    let l_act = cancel_step.lightning_action.as_ref().unwrap();
    assert_eq!(l_act.status, "CANCELED");
}

#[test]
fn respects_custom_trade_amount_and_rejects_out_of_bounds() {
    let config = sample_config();

    // Menor al mínimo (10_000)
    let too_low =
        simulation::run_simulation(&config, None, SimulationScenario::HappyPath, Some(5_000));
    assert!(too_low.is_err());

    // Mayor al máximo (1_000_000)
    let too_high = simulation::run_simulation(
        &config,
        None,
        SimulationScenario::HappyPath,
        Some(2_000_000),
    );
    assert!(too_high.is_err());

    // Cero sats
    let zero_sats =
        simulation::run_simulation(&config, None, SimulationScenario::HappyPath, Some(0));
    assert!(zero_sats.is_err());
}

#[test]
fn cli_simulation_strict_argument_parsing_and_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = mostro_community_api::store::Store::open(dir.path().into()).unwrap();
    store.save(sample_config()).unwrap();

    // 1. Sin argumentos: default happy-path con monto clamped válido
    let res = simulation::run_cli_simulation(dir.path(), &[]).unwrap();
    assert_eq!(res.scenario, SimulationScenario::HappyPath);
    assert_eq!(res.financials.trade_amount_sats, 50_000);
    assert_eq!(res.simulation_mode, "synthetic_dry_run");
    assert!(res.disclaimer.contains("sintética"));

    // 2. Escenario explícito soportado
    let res = simulation::run_cli_simulation(dir.path(), &["cancel".into()]).unwrap();
    assert_eq!(res.scenario, SimulationScenario::SellerCancellation);

    let res = simulation::run_cli_simulation(dir.path(), &["dispute-buyer".into(), "25000".into()])
        .unwrap();
    assert_eq!(res.scenario, SimulationScenario::DisputeSettledForBuyer);
    assert_eq!(res.financials.trade_amount_sats, 25_000);

    // 3. Escenario inválido -> Error (NO sustituido silenciosamente por default)
    let err =
        simulation::run_cli_simulation(dir.path(), &["invented_scenario".into()]).unwrap_err();
    assert!(err.contains("Escenario de simulación no válido"));

    // 4. Monto negativo -> Error
    let err = simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "-500".into()])
        .unwrap_err();
    assert!(err.contains("Monto de intercambio inválido"));

    // 5. Monto decimal -> Error
    let err = simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "50000.5".into()])
        .unwrap_err();
    assert!(err.contains("Monto de intercambio inválido"));

    // 6. Monto cero -> Error
    let err =
        simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "0".into()]).unwrap_err();
    assert!(err.contains("Monto de intercambio inválido"));

    // 7. Monto no numérico -> Error
    let err = simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "abc".into()])
        .unwrap_err();
    assert!(err.contains("Monto de intercambio inválido"));

    // 8. Monto con overflow -> Error
    let err = simulation::run_cli_simulation(
        dir.path(),
        &["happy-path".into(), "99999999999999999999999999".into()],
    )
    .unwrap_err();
    assert!(err.contains("Monto de intercambio inválido"));

    // 9. Monto fuera de límites de comunidad (menor a 10_000 o mayor a 1_000_000)
    let err = simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "5000".into()])
        .unwrap_err();
    assert!(err.contains("fuera de los límites de la comunidad"));

    let err = simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "5000000".into()])
        .unwrap_err();
    assert!(err.contains("fuera de los límites de la comunidad"));

    // 10. Argumentos sobrantes -> Error
    let err = simulation::run_cli_simulation(
        dir.path(),
        &["happy-path".into(), "50000".into(), "extra".into()],
    )
    .unwrap_err();
    assert!(err.contains("Demasiados argumentos para simulate-trade"));

    // 11. Sin configuración previa -> Error
    let empty_dir = tempfile::tempdir().unwrap();
    let err = simulation::run_cli_simulation(empty_dir.path(), &[]).unwrap_err();
    assert!(err.contains("Falta configurar la comunidad antes de simular"));
}

#[test]
fn simulation_isolation_never_reads_or_mutates_identity_and_config_files() {
    use nostr::{Keys, SecretKey, ToBech32};
    use sha2::{Digest, Sha256};
    use std::fs;

    let dir = tempfile::tempdir().unwrap();

    // 1. Guardar configuración de comunidad
    let mut store = mostro_community_api::store::Store::open(dir.path().into()).unwrap();
    store.save(sample_config()).unwrap();
    let config_path = dir.path().join("community.json");
    let config_before_bytes = fs::read(&config_path).unwrap();
    let config_hash_before = format!("{:x}", Sha256::digest(&config_before_bytes));

    // 2. Importar una identidad sintética secreta
    let keys = Keys::new(SecretKey::from_slice(&[42; 32]).unwrap());
    let secret_nsec = keys.secret_key().to_bech32().unwrap();
    let real_npub = keys.public_key().to_bech32().unwrap();
    mostro_community_api::identity::import(dir.path(), &secret_nsec, &real_npub).unwrap();

    let identity_path = dir.path().join("identity").join("mostro.nsec");
    let identity_before_bytes = fs::read(&identity_path).unwrap();
    let identity_hash_before = format!("{:x}", Sha256::digest(&identity_before_bytes));
    let identity_meta_before = fs::metadata(&identity_path).unwrap();

    // 3. Ejecutar simulación
    let report = simulation::run_cli_simulation(dir.path(), &["happy-path".into(), "50000".into()])
        .expect("Simulación CLI falló");

    // 4. Verificar que la identidad usada por la simulación es SINTÉTICA y NO la real
    assert_ne!(report.bot_npub, real_npub);
    assert_eq!(report.bot_npub, simulation::SYNTHETIC_BOT_NPUB);

    // 5. Verificar que los ficheros de identidad y configuración permanecen 100% intactos
    let config_after_bytes = fs::read(&config_path).unwrap();
    let config_hash_after = format!("{:x}", Sha256::digest(&config_after_bytes));
    assert_eq!(
        config_hash_before, config_hash_after,
        "community.json fue modificado!"
    );

    let identity_after_bytes = fs::read(&identity_path).unwrap();
    let identity_hash_after = format!("{:x}", Sha256::digest(&identity_after_bytes));
    assert_eq!(
        identity_hash_before, identity_hash_after,
        "mostro.nsec fue alterado!"
    );

    let identity_meta_after = fs::metadata(&identity_path).unwrap();
    assert_eq!(
        identity_meta_before.permissions(),
        identity_meta_after.permissions()
    );
}

#[test]
fn fee_calculation_matches_upstream_rounding_and_edge_cases() {
    let mut config = sample_config();

    // Caso 1: 10,000 sats con 25 bps (0.25%) -> 12.5 sats por lado -> redondeo 13 sats, total real 26 sats
    config.market.fee_bps = 25;
    config.market.dev_fee_bps = 1000; // 10%
    let fin1 = simulation::calculate_financials(&config, 10_000, "EUR", "6.00");
    assert_eq!(fin1.fee_per_side_sats, 13);
    assert_eq!(fin1.total_mostro_fee_sats, 26);
    assert_eq!(fin1.fee_sats, 26);
    // Dev fee: 26 * 10% = 2.6 -> round = 3
    assert_eq!(fin1.dev_fee_sats, 3);

    // Caso 2: Medio satoshi exacto: 1,000 sats con 30 bps (0.30%) -> 1.5 sats por lado -> round 2 sats, total 4 sats
    config.market.fee_bps = 30;
    let fin2 = simulation::calculate_financials(&config, 1_000, "EUR", "0.60");
    assert_eq!(fin2.fee_per_side_sats, 2);
    assert_eq!(fin2.total_mostro_fee_sats, 4);

    // Caso 3: Tarifa cero: 0 bps
    config.market.fee_bps = 0;
    config.market.dev_fee_bps = 0;
    let fin3 = simulation::calculate_financials(&config, 50_000, "EUR", "30.00");
    assert_eq!(fin3.fee_per_side_sats, 0);
    assert_eq!(fin3.total_mostro_fee_sats, 0);
    assert_eq!(fin3.dev_fee_sats, 0);

    // Caso 4: Límite máximo admitido (100 millones de sats con 100 bps = 1%)
    config.market.fee_bps = 100;
    config.market.dev_fee_bps = 500; // 5%
    let fin4 = simulation::calculate_financials(&config, 100_000_000, "EUR", "60000.00");
    // 100,000,000 * 0.01 / 2 = 500,000 sats por lado
    assert_eq!(fin4.fee_per_side_sats, 500_000);
    assert_eq!(fin4.total_mostro_fee_sats, 1_000_000);
    // Dev fee: 1,000,000 * 5% = 50,000
    assert_eq!(fin4.dev_fee_sats, 50_000);

    // Verificación de resolución explícita de hold invoices en todos los escenarios
    let scenarios = [
        SimulationScenario::HappyPath,
        SimulationScenario::DisputeSettledForBuyer,
        SimulationScenario::DisputeRefundedToSeller,
        SimulationScenario::SellerCancellation,
    ];
    for sc in scenarios {
        let rep = simulation::run_simulation(&config, None, sc, Some(50_000)).unwrap();
        // Todas las acciones de hold invoice aceptadas deben tener una resolución final
        let mut accepted_hashes = std::collections::HashSet::new();
        let mut resolved_hashes = std::collections::HashSet::new();
        for st in &rep.steps {
            if let Some(la) = &st.lightning_action {
                if la.status == "ACCEPTED" {
                    accepted_hashes.insert(la.payment_hash.clone());
                } else if la.status == "SETTLED" || la.status == "CANCELED" {
                    resolved_hashes.insert(la.payment_hash.clone());
                }
            }
        }
        for hash in &accepted_hashes {
            assert!(
                resolved_hashes.contains(hash),
                "Escenario {:?} dejó una hold invoice aceptada sin resolución final explícita: {}",
                sc,
                hash
            );
        }
    }
}
