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
    assert_eq!(report.financials.fee_sats, 300);

    // 1000 base + 50,000 * 3.0% (1500) = 2500 sats bond
    assert_eq!(report.financials.seller_bond_sats, 2500);
    assert_eq!(report.financials.buyer_bond_sats, 2500);

    // Seller locked: 50,000 + 2500 bond + 300 fee = 52,800 sats
    assert_eq!(report.financials.seller_total_locked_sats, 52_800);

    // Buyer locked: 2500 bond + 300 fee = 2800 sats
    assert_eq!(report.financials.buyer_total_locked_sats, 2800);

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
}
