//! Regtest and protocol simulation engine for Mostro P2P trades.
//! Simulates the complete order lifecycle, hold invoices, bonds, fee accounting,
//! and dispute resolution without exposing real satoshis or private keys.

use crate::config::{BondApply, Configuration};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SimulationScenario {
    HappyPath,
    DisputeSettledForBuyer,
    DisputeRefundedToSeller,
    SellerCancellation,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Seller,
    Buyer,
    Mostro,
    Solver,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct NostrEventSummary {
    pub kind: u64,
    pub event_id: String,
    pub sender: String,
    pub recipient: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LightningActionSummary {
    pub action: String,
    pub amount_sats: u64,
    pub payment_hash: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SimulationStep {
    pub step_number: usize,
    pub action_code: String,
    pub title: String,
    pub actor: Actor,
    pub order_status: String,
    pub description: String,
    pub nostr_event: Option<NostrEventSummary>,
    pub lightning_action: Option<LightningActionSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinancialBreakdown {
    pub trade_amount_sats: u64,
    pub fiat_currency: String,
    pub fiat_amount: String,
    pub seller_bond_sats: u64,
    pub buyer_bond_sats: u64,
    pub total_mostro_fee_sats: u64,
    pub fee_per_side_sats: u64,
    pub dev_fee_sats: u64,
    #[serde(default)]
    pub fee_sats: u64,
    pub seller_total_locked_sats: u64,
    pub buyer_total_locked_sats: u64,
}

pub const SYNTHETIC_BOT_NPUB: &str =
    "npub1synthet1c0mostro0bot0community0dryrun000000000000000000000000";
pub const SYNTHETIC_SELLER_NPUB: &str =
    "npub1synthet1c0seller00000000000000000000000000000000000000000001";
pub const SYNTHETIC_BUYER_NPUB: &str =
    "npub1synthet1c0buyer000000000000000000000000000000000000000000002";
pub const SYNTHETIC_SOLVER_NPUB: &str =
    "npub1synthet1c0solver00000000000000000000000000000000000000000003";

pub const SIMULATION_MODE_LABEL: &str = "synthetic_dry_run";
pub const SIMULATION_DISCLAIMER: &str = "Simulación sintética en memoria: no ejecuta regtest ni interactúa con nodos Bitcoin/Lightning o relays Nostr reales; eventos y transacciones son modelos para verificación previa; equivalencia fiat referencial sin oráculo en tiempo real; no valida conformidad de cliente upstream.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SimulationReport {
    pub scenario: SimulationScenario,
    pub order_id: String,
    pub bot_npub: String,
    pub payment_method: String,
    pub financials: FinancialBreakdown,
    pub steps: Vec<SimulationStep>,
    pub final_status: String,
    pub is_success: bool,
    pub duration_simulated_ms: u64,
    pub timestamp_unix: u64,
    pub simulation_mode: String,
    pub disclaimer: String,
}

fn hash_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn calculate_financials(
    config: &Configuration,
    trade_sats: u64,
    fiat_code: &str,
    fiat_amount: &str,
) -> FinancialBreakdown {
    // Upstream Mostro v0.18.8 src/util.rs calculates:
    // split_fee = (mostro_settings.fee * amount as f64) / 2.0; split_fee.round() as i64
    // Using checked u128 integer arithmetic with exact rounding:
    // round(X / 20000) = (X + 10000) / 20000
    let fee_bps_u128 = config.market.fee_bps as u128;
    let trade_sats_u128 = trade_sats as u128;
    let fee_per_side_sats = ((trade_sats_u128
        .saturating_mul(fee_bps_u128)
        .saturating_add(10_000))
        / 20_000) as u64;

    // Real total fee retained by Mostro node is exactly 2 * fee_per_side
    let total_mostro_fee_sats = fee_per_side_sats.saturating_mul(2);

    // Upstream dev_fee is a share of the total Mostro fee collected:
    // dev_fee = (total_mostro_fee as f64) * percentage; dev_fee.round() as i64
    let dev_fee_bps_u128 = config.market.dev_fee_bps as u128;
    let dev_fee_sats = (((total_mostro_fee_sats as u128)
        .saturating_mul(dev_fee_bps_u128)
        .saturating_add(5_000))
        / 10_000) as u64;

    let bond_sats = if config.safety.bond_enabled {
        let bond_bps_u128 = config.safety.bond_bps as u128;
        let variable_bond = ((trade_sats_u128
            .saturating_mul(bond_bps_u128)
            .saturating_add(5_000))
            / 10_000) as u64;
        config.safety.base_bond_sats.saturating_add(variable_bond)
    } else {
        0
    };

    let (seller_bond, buyer_bond) = match config.safety.bond_apply_to {
        BondApply::Make => (bond_sats, 0),
        BondApply::Take => (0, bond_sats),
        BondApply::Both => (bond_sats, bond_sats),
    };

    let seller_total_locked = trade_sats
        .saturating_add(seller_bond)
        .saturating_add(fee_per_side_sats);
    let buyer_total_locked = buyer_bond.saturating_add(fee_per_side_sats);

    FinancialBreakdown {
        trade_amount_sats: trade_sats,
        fiat_currency: fiat_code.to_string(),
        fiat_amount: fiat_amount.to_string(),
        seller_bond_sats: seller_bond,
        buyer_bond_sats: buyer_bond,
        total_mostro_fee_sats,
        fee_per_side_sats,
        dev_fee_sats,
        fee_sats: total_mostro_fee_sats,
        seller_total_locked_sats: seller_total_locked,
        buyer_total_locked_sats: buyer_total_locked,
    }
}

pub fn run_simulation(
    config: &Configuration,
    bot_npub: Option<&str>,
    scenario: SimulationScenario,
    custom_trade_sats: Option<u64>,
) -> Result<SimulationReport, &'static str> {
    let min_sats = config.market.min_trade_sats;
    let max_sats = config.market.max_trade_sats;

    let trade_sats = match custom_trade_sats {
        Some(sats) => {
            if sats == 0 || sats < min_sats || sats > max_sats {
                return Err("Monto de intercambio fuera de los límites de la comunidad");
            }
            sats
        }
        None => {
            let candidate = 50_000.clamp(min_sats, max_sats);
            if candidate == 0 {
                return Err("Límites de mercado no válidos para simulación");
            }
            candidate
        }
    };

    let fiat_code = config
        .market
        .fiat_currencies
        .first()
        .map(|s| s.as_str())
        .unwrap_or("EUR");

    let fiat_amount = match fiat_code {
        "EUR" => "30.00",
        "USD" => "32.50",
        "GBP" => "26.00",
        _ => "30.00",
    };

    let payment_method = config
        .payment_methods
        .iter()
        .find(|m| m.active)
        .map(|m| m.label.clone())
        .unwrap_or_else(|| "Transferencia SEPA / Instant".to_string());

    let financials = calculate_financials(config, trade_sats, fiat_code, fiat_amount);

    let bot = bot_npub.unwrap_or(SYNTHETIC_BOT_NPUB);
    let seller_npub = SYNTHETIC_SELLER_NPUB;
    let buyer_npub = SYNTHETIC_BUYER_NPUB;
    let solver_npub = SYNTHETIC_SOLVER_NPUB;

    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let order_id = format!(
        "ord-{}",
        &hash_hex(&format!("{}-{}", now_unix, trade_sats))[0..12]
    );
    let seller_hash = hash_hex(&format!("{}-seller-hold", order_id));
    let buyer_hash = hash_hex(&format!("{}-buyer-hold", order_id));

    let mut steps = Vec::new();
    let mut step_count = 1;

    // Paso 1: Vendedor solicita nueva orden
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "new_order".into(),
        title: "Creación de Orden de Venta".into(),
        actor: Actor::Seller,
        order_status: "pending".into(),
        description: format!(
            "Vendedor solicita publicar orden para vender {} sats por {} {} usando {}.",
            financials.trade_amount_sats,
            financials.fiat_amount,
            financials.fiat_currency,
            payment_method
        ),
        nostr_event: Some(NostrEventSummary {
            kind: 4,
            event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
            sender: seller_npub.into(),
            recipient: Some(bot.into()),
            summary: format!(
                "Order Action: NewOrder (Sell, {} sats)",
                financials.trade_amount_sats
            ),
        }),
        lightning_action: None,
    });
    step_count += 1;

    // Paso 2: Mostro genera Hold Invoice para el Vendedor (Monto + Bond + Fee)
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "hold_invoice_created".into(),
        title: "Bloqueo de Garantía del Vendedor (Hold Invoice)".into(),
        actor: Actor::Mostro,
        order_status: "waiting_payment".into(),
        description: format!(
            "Mostro genera Hold Invoice de {} sats ({} trade + {} fianza + {} fee/2). Vendedor la paga para activar la orden.",
            financials.seller_total_locked_sats,
            financials.trade_amount_sats,
            financials.seller_bond_sats,
            financials.fee_per_side_sats
        ),
        nostr_event: Some(NostrEventSummary {
            kind: 4,
            event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
            sender: bot.into(),
            recipient: Some(seller_npub.into()),
            summary: format!("Hold invoice enviada: {} sats", financials.seller_total_locked_sats),
        }),
        lightning_action: Some(LightningActionSummary {
            action: "HoldInvoiceCreated".into(),
            amount_sats: financials.seller_total_locked_sats,
            payment_hash: seller_hash.clone(),
            status: "OPEN".into(),
        }),
    });
    step_count += 1;

    // Paso 3: Vendedor paga Hold Invoice -> Orden pasa a Active en Relays
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "hold_invoice_accepted".into(),
        title: "Fondo Bloqueado y Publicación en Relays".into(),
        actor: Actor::Seller,
        order_status: "active".into(),
        description: "El nodo Lightning acepta y congela los fondos del vendedor. Mostro publica la orden en los relays Nostr (Kind 38383).".into(),
        nostr_event: Some(NostrEventSummary {
            kind: 38383,
            event_id: hash_hex(&format!("{}-order-kind38383", order_id)),
            sender: bot.into(),
            recipient: None,
            summary: format!("Kind 38383: Orden disponible para compra ({}, {} sats)", financials.fiat_currency, financials.trade_amount_sats),
        }),
        lightning_action: Some(LightningActionSummary {
            action: "HoldInvoiceAccepted".into(),
            amount_sats: financials.seller_total_locked_sats,
            payment_hash: seller_hash.clone(),
            status: "ACCEPTED".into(),
        }),
    });
    step_count += 1;

    if scenario == SimulationScenario::SellerCancellation {
        steps.push(SimulationStep {
            step_number: step_count,
            action_code: "cancel_order".into(),
            title: "Cancelación de Orden por Vendedor".into(),
            actor: Actor::Seller,
            order_status: "canceled".into(),
            description: "El vendedor cancela la orden antes de que nadie la tome. Mostro cancela la Hold Invoice sin costo.".into(),
            nostr_event: Some(NostrEventSummary {
                kind: 4,
                event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
                sender: seller_npub.into(),
                recipient: Some(bot.into()),
                summary: "Order Action: Cancel".into(),
            }),
            lightning_action: Some(LightningActionSummary {
                action: "HoldInvoiceCanceled".into(),
                amount_sats: financials.seller_total_locked_sats,
                payment_hash: seller_hash,
                status: "CANCELED".into(),
            }),
        });

        return Ok(SimulationReport {
            scenario,
            order_id,
            bot_npub: bot.into(),
            payment_method,
            financials,
            steps,
            final_status: "canceled".into(),
            is_success: true,
            duration_simulated_ms: 1250,
            timestamp_unix: now_unix,
            simulation_mode: SIMULATION_MODE_LABEL.into(),
            disclaimer: SIMULATION_DISCLAIMER.into(),
        });
    }

    // Paso 4: Comprador toma la orden
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "take_sell".into(),
        title: "Comprador Acepta la Oferta (TakeSell)".into(),
        actor: Actor::Buyer,
        order_status: "waiting_buyer_invoice".into(),
        description: format!(
            "El comprador envía TakeSell a Mostro y aporta una factura Lightning de {} sats para recibir sus fondos.",
            financials.trade_amount_sats
        ),
        nostr_event: Some(NostrEventSummary {
            kind: 4,
            event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
            sender: buyer_npub.into(),
            recipient: Some(bot.into()),
            summary: format!("Order Action: TakeSell ({}) con factura de destino", order_id),
        }),
        lightning_action: None,
    });
    step_count += 1;

    // Paso 5: Comprador paga su Fianza (Bond)
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "buyer_bond_accepted".into(),
        title: "Bloqueo de Garantía del Comprador".into(),
        actor: Actor::Buyer,
        order_status: "waiting_buyer_invoice".into(),
        description: format!(
            "El comprador paga la factura de fianza ({} sats bond + {} fee/2 = {} sats total).",
            financials.buyer_bond_sats,
            financials.fee_per_side_sats,
            financials.buyer_total_locked_sats
        ),
        nostr_event: Some(NostrEventSummary {
            kind: 4,
            event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
            sender: bot.into(),
            recipient: Some(buyer_npub.into()),
            summary: format!(
                "Pago de fianza comprador {} sats confirmado",
                financials.buyer_total_locked_sats
            ),
        }),
        lightning_action: Some(LightningActionSummary {
            action: "BuyerBondHoldInvoiceAccepted".into(),
            amount_sats: financials.buyer_total_locked_sats,
            payment_hash: buyer_hash.clone(),
            status: "ACCEPTED".into(),
        }),
    });
    step_count += 1;

    // Paso 6: Mostro coordina intercambio Fiat
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "fiat_coordination".into(),
        title: "Coordinación de Pago Fiat".into(),
        actor: Actor::Mostro,
        order_status: "waiting_payment".into(),
        description: format!(
            "Mostro envía los datos de pago al comprador: {} {} vía {}. Se inicia ventana de pago.",
            financials.fiat_amount, financials.fiat_currency, payment_method
        ),
        nostr_event: Some(NostrEventSummary {
            kind: 4,
            event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
            sender: bot.into(),
            recipient: Some(buyer_npub.into()),
            summary: format!(
                "Detalles de pago compartidos: {} {}",
                financials.fiat_amount, financials.fiat_currency
            ),
        }),
        lightning_action: None,
    });
    step_count += 1;

    // Paso 7: Comprador envía dinero fiat y confirma
    steps.push(SimulationStep {
        step_number: step_count,
        action_code: "fiat_sent".into(),
        title: "Comprador Notifica Pago Fiat (FiatSent)".into(),
        actor: Actor::Buyer,
        order_status: "fiat_sent".into(),
        description: format!(
            "El comprador realiza la transferencia bancaria de {} {} y envía FiatSent a Mostro.",
            financials.fiat_amount, financials.fiat_currency
        ),
        nostr_event: Some(NostrEventSummary {
            kind: 4,
            event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
            sender: buyer_npub.into(),
            recipient: Some(bot.into()),
            summary: "Order Action: FiatSent".into(),
        }),
        lightning_action: None,
    });
    step_count += 1;

    match scenario {
        SimulationScenario::HappyPath => {
            // Paso 8: Vendedor verifica fondos y libera
            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "release".into(),
                title: "Vendedor Confirma Recepción y Libera (Release)".into(),
                actor: Actor::Seller,
                order_status: "settled_hold_invoice".into(),
                description: format!(
                    "El vendedor comprueba en su aplicación de banca la recepción de los {} {} y envía Release a Mostro.",
                    financials.fiat_amount, financials.fiat_currency
                ),
                nostr_event: Some(NostrEventSummary {
                kind: 4,
                event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
                sender: seller_npub.into(),
                recipient: Some(bot.into()),
                summary: "Order Action: Release".into(),
            }),
                lightning_action: Some(LightningActionSummary {
                    action: "SellerHoldInvoiceSettled".into(),
                    amount_sats: financials.seller_total_locked_sats,
                    payment_hash: seller_hash,
                    status: "SETTLED".into(),
                }),
            });
            step_count += 1;

            // Paso 9: Liquidación y Entrega de Satoshis
            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "success".into(),
                title: "Liquidación Lightning y Devolución de Fianzas".into(),
                actor: Actor::Mostro,
                order_status: "success".into(),
                description: format!(
                    "Mostro paga {} sats a la factura del comprador, devuelve {} sats de fianza al vendedor y {} sats al comprador. Comisión de {} sats recaudada (Dev fee: {} sats).",
                    financials.trade_amount_sats,
                    financials.seller_bond_sats,
                    financials.buyer_bond_sats,
                    financials.total_mostro_fee_sats,
                    financials.dev_fee_sats
                ),
                nostr_event: Some(NostrEventSummary {
                    kind: 38383,
                    event_id: hash_hex(&format!("{}-step-success", order_id)),
                    sender: bot.into(),
                    recipient: None,
                    summary: "Order Status: Success (Trade finalizado)".into(),
                }),
                lightning_action: Some(LightningActionSummary {
                    action: "PayoutToBuyerDispatched".into(),
                    amount_sats: financials.trade_amount_sats,
                    payment_hash: buyer_hash,
                    status: "SETTLED".into(),
                }),
            });

            Ok(SimulationReport {
                scenario,
                order_id,
                bot_npub: bot.into(),
                payment_method,
                financials,
                steps,
                final_status: "success".into(),
                is_success: true,
                duration_simulated_ms: 2400,
                timestamp_unix: now_unix,
                simulation_mode: SIMULATION_MODE_LABEL.into(),
                disclaimer: SIMULATION_DISCLAIMER.into(),
            })
        }
        SimulationScenario::DisputeSettledForBuyer => {
            // Disputa abierta
            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "dispute_opened".into(),
                title: "Apertura de Disputa (Dispute)".into(),
                actor: Actor::Seller,
                order_status: "dispute".into(),
                description: "El vendedor no ve reflejado el dinero en el tiempo límite y abre una disputa ante Mostro.".into(),
                nostr_event: Some(NostrEventSummary {
                    kind: 4,
                    event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
                    sender: seller_npub.into(),
                    recipient: Some(bot.into()),
                    summary: "Order Action: Dispute (Conflicto abierto)".into(),
                }),
                lightning_action: None,
            });
            step_count += 1;

            // Solver interviene y falla a favor del comprador
            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "adm_settle".into(),
                title: "Resolución del Mediador a Favor del Comprador (AdmSettle)".into(),
                actor: Actor::Solver,
                order_status: "settled_hold_invoice".into(),
                description: "El mediador (Solver) comprueba justificante bancario oficial válido. Emite resolución AdmSettle para liberar los satoshis al comprador.".into(),
                nostr_event: Some(NostrEventSummary {
                    kind: 4,
                    event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
                    sender: solver_npub.into(),
                    recipient: Some(bot.into()),
                    summary: "Admin Action: AdmSettle (Fallo favorable a comprador)".into(),
                }),
                lightning_action: Some(LightningActionSummary {
                    action: "SellerHoldInvoiceSettledBySolver".into(),
                    amount_sats: financials.seller_total_locked_sats,
                    payment_hash: seller_hash,
                    status: "SETTLED".into(),
                }),
            });
            step_count += 1;

            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "dispute_payout".into(),
                title: "Liquidación Final Forzada".into(),
                actor: Actor::Mostro,
                order_status: "success".into(),
                description: format!(
                    "Mostro ejecuta el fallo del solver: entrega {} sats al comprador, devuelve fianza al comprador y retiene o penaliza según política.",
                    financials.trade_amount_sats
                ),
                nostr_event: Some(NostrEventSummary {
                    kind: 38383,
                    event_id: hash_hex(&format!("{}-dispute-success", order_id)),
                    sender: bot.into(),
                    recipient: None,
                    summary: "Order Status: Success (Resuelto por mediación)".into(),
                }),
                lightning_action: Some(LightningActionSummary {
                    action: "DisputePayoutDispatched".into(),
                    amount_sats: financials.trade_amount_sats,
                    payment_hash: buyer_hash,
                    status: "SETTLED".into(),
                }),
            });

            Ok(SimulationReport {
                scenario,
                order_id,
                bot_npub: bot.into(),
                payment_method,
                financials,
                steps,
                final_status: "success_dispute_resolved".into(),
                is_success: true,
                duration_simulated_ms: 3800,
                timestamp_unix: now_unix,
                simulation_mode: SIMULATION_MODE_LABEL.into(),
                disclaimer: SIMULATION_DISCLAIMER.into(),
            })
        }
        SimulationScenario::DisputeRefundedToSeller => {
            // Disputa abierta
            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "dispute_opened".into(),
                title: "Apertura de Disputa por Falta de Pago Real".into(),
                actor: Actor::Seller,
                order_status: "dispute".into(),
                description: "El comprador marcó FiatSent pero nunca transfirió los fondos. El vendedor abre disputa.".into(),
                nostr_event: Some(NostrEventSummary {
                    kind: 4,
                    event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
                    sender: seller_npub.into(),
                    recipient: Some(bot.into()),
                    summary: "Order Action: Dispute".into(),
                }),
                lightning_action: None,
            });
            step_count += 1;

            // Solver falla a favor del vendedor
            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "adm_refund".into(),
                title: "Resolución del Mediador con Devolución al Vendedor (AdmRefund)".into(),
                actor: Actor::Solver,
                order_status: "canceled".into(),
                description: "El comprador no aportó evidencia bancaria legítima. El mediador emite AdmRefund para reembolsar los sats al vendedor y penalizar el bond del comprador.".into(),
                nostr_event: Some(NostrEventSummary {
                    kind: 4,
                    event_id: hash_hex(&format!("{}-step-{}", order_id, step_count)),
                    sender: solver_npub.into(),
                    recipient: Some(bot.into()),
                    summary: "Admin Action: AdmRefund".into(),
                }),
                lightning_action: Some(LightningActionSummary {
                    action: "SellerHoldInvoiceCanceled".into(),
                    amount_sats: financials.seller_total_locked_sats,
                    payment_hash: seller_hash,
                    status: "CANCELED".into(),
                }),
            });
            step_count += 1;

            steps.push(SimulationStep {
                step_number: step_count,
                action_code: "buyer_bond_slashed".into(),
                title: "Ejecución de Penalización de Fianza del Comprador".into(),
                actor: Actor::Mostro,
                order_status: "canceled".into(),
                description: format!(
                    "Mostro ejecuta la penalización dictada por el mediador: liquida la factura de fianza del comprador ({} sats) reteniendo los fondos por incumplimiento.",
                    financials.buyer_total_locked_sats
                ),
                nostr_event: None,
                lightning_action: Some(LightningActionSummary {
                    action: "BuyerBondHoldInvoiceSettled".into(),
                    amount_sats: financials.buyer_total_locked_sats,
                    payment_hash: buyer_hash,
                    status: "SETTLED".into(),
                }),
            });

            Ok(SimulationReport {
                scenario,
                order_id,
                bot_npub: bot.into(),
                payment_method,
                financials,
                steps,
                final_status: "refunded_to_seller".into(),
                is_success: true,
                duration_simulated_ms: 3600,
                timestamp_unix: now_unix,
                simulation_mode: SIMULATION_MODE_LABEL.into(),
                disclaimer: SIMULATION_DISCLAIMER.into(),
            })
        }
        SimulationScenario::SellerCancellation => unreachable!(),
    }
}

/// Runs a simulation invoked via CLI, performing strict validation on all arguments.
/// Never defaults silently when explicit invalid scenarios or amounts are supplied.
pub fn run_cli_simulation(
    root: &std::path::Path,
    args: &[String],
) -> Result<SimulationReport, String> {
    if args.len() > 2 {
        return Err(
            "Demasiados argumentos para simulate-trade. Uso: simulate-trade [escenario] [sats]"
                .into(),
        );
    }

    let scenario = if args.is_empty() {
        SimulationScenario::HappyPath
    } else {
        match args[0].as_str() {
            "happy-path" | "happy_path" => SimulationScenario::HappyPath,
            "dispute-buyer" | "dispute_settled_for_buyer" => {
                SimulationScenario::DisputeSettledForBuyer
            }
            "dispute-seller" | "dispute_refunded_to_seller" => {
                SimulationScenario::DisputeRefundedToSeller
            }
            "cancel" | "seller_cancellation" => SimulationScenario::SellerCancellation,
            other => {
                return Err(format!(
                    "Escenario de simulación no válido: '{other}'. Escenarios soportados: happy-path, dispute-buyer, dispute-seller, cancel"
                ));
            }
        }
    };

    let store = crate::store::Store::open(root.to_path_buf())
        .map_err(|e| format!("Error al abrir almacenamiento: {e}"))?;
    let config = store
        .document
        .config
        .as_ref()
        .ok_or_else(|| "Falta configurar la comunidad antes de simular".to_string())?;

    let custom_trade_sats = if args.len() == 2 {
        let raw = &args[1];
        let sats: u64 = raw.parse::<u64>().map_err(|_| {
            format!(
                "Monto de intercambio inválido: '{raw}'. Debe ser un número entero de satoshis positivo sin decimales ni desbordamiento"
            )
        })?;
        if sats == 0 {
            return Err("Monto de intercambio inválido: debe ser mayor a cero".into());
        }
        if sats < config.market.min_trade_sats || sats > config.market.max_trade_sats {
            return Err(format!(
                "Monto de intercambio {sats} sats fuera de los límites de la comunidad (mínimo: {}, máximo: {})",
                config.market.min_trade_sats, config.market.max_trade_sats
            ));
        }
        Some(sats)
    } else {
        None
    };

    run_simulation(config, None, scenario, custom_trade_sats).map_err(|e| e.to_string())
}
