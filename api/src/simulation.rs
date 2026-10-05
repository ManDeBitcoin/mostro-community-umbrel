//! Synthetic walkthrough of a Mostro trade, following what mostrod v0.19.2 does.
//!
//! The sequence of messages, order statuses and hold invoices mirrors a trade
//! run against the official v0.19.2 binary on regtest (see
//! `docs/validation.md`). Nothing here touches Lightning, relays or keys.

use crate::config::{BondApply, Configuration, MIN_DEV_FEE_BPS};
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
    /// Escrow hold invoice the seller pays: trade amount plus the seller's
    /// half of the fee.
    #[serde(default)]
    pub seller_hold_invoice_sats: u64,
    /// What the buyer's invoice receives: trade amount minus the buyer's half
    /// of the fee. The buyer never pays the fee up front.
    #[serde(default)]
    pub buyer_receives_sats: u64,
    /// Everything the seller has locked at once: escrow plus bond, which are
    /// two separate hold invoices.
    pub seller_total_locked_sats: u64,
    /// Everything the buyer has locked: only the bond, when one applies.
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
pub const SIMULATION_DISCLAIMER: &str = "Simulación sintética en memoria: no ejecuta regtest ni interactúa con nodos Bitcoin/Lightning o relays Nostr reales. La secuencia de mensajes y facturas sigue la de Mostro v0.19.2; los importes se calculan con la configuración guardada y la equivalencia fiat es referencial, sin cotización en tiempo real.";

/// Appends one step to the walkthrough.
type PushStep<'a> = dyn FnMut(
        &str,
        &str,
        Actor,
        &str,
        String,
        Option<NostrEventSummary>,
        Option<LightningActionSummary>,
    ) + 'a;

/// Kind of every user↔daemon message in protocol v2 (NIP-44 encrypted).
const KIND_PROTOCOL_MESSAGE: u64 = 14;
/// Public order event.
const KIND_ORDER: u64 = 38383;
/// Public dispute event.
const KIND_DISPUTE: u64 = 38386;

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
    // Upstream mostrod v0.19.2 `src/util.rs::get_fee`:
    //   split_fee = (mostro_settings.fee * amount as f64) / 2.0; split_fee.round()
    // In integer arithmetic: round(X / 20000) = (X + 10000) / 20000.
    let fee_bps_u128 = config.market.fee_bps as u128;
    let trade_sats_u128 = trade_sats as u128;

    // Checked arithmetic without silent overflow
    let fee_per_side_sats = trade_sats_u128
        .checked_mul(fee_bps_u128)
        .unwrap_or(0)
        .checked_add(10_000)
        .unwrap_or(0)
        .checked_div(20_000)
        .unwrap_or(0) as u64;

    // The node keeps exactly one half from each party.
    let total_mostro_fee_sats = fee_per_side_sats.checked_mul(2).unwrap_or(0);

    // `calculate_dev_fee`: share of the total fee sent to Mostro development.
    // The renderer never writes less than the minimum mostrod accepts.
    let dev_fee_bps_u128 = config.market.dev_fee_bps.max(MIN_DEV_FEE_BPS) as u128;
    let dev_fee_sats = (total_mostro_fee_sats as u128)
        .checked_mul(dev_fee_bps_u128)
        .unwrap_or(0)
        .checked_add(5_000)
        .unwrap_or(0)
        .checked_div(10_000)
        .unwrap_or(0) as u64;

    // `src/app/bond/math.rs::compute_bond_amount`:
    //   bond = max(round(amount_pct * order_amount_sats), base_amount_sats)
    // The base amount is a floor, not an addition.
    let bond_sats = if config.safety.bond_enabled {
        let bond_bps_u128 = config.safety.bond_bps as u128;
        let proportional = trade_sats_u128
            .checked_mul(bond_bps_u128)
            .unwrap_or(0)
            .checked_add(5_000)
            .unwrap_or(0)
            .checked_div(10_000)
            .unwrap_or(0) as u64;
        proportional.max(config.safety.base_bond_sats)
    } else {
        0
    };

    // In this walkthrough the seller is the maker and the buyer the taker.
    let (seller_bond, buyer_bond) = match config.safety.bond_apply_to {
        BondApply::Make => (bond_sats, 0),
        BondApply::Take => (0, bond_sats),
        BondApply::Both => (bond_sats, bond_sats),
    };

    let seller_hold_invoice_sats = trade_sats.saturating_add(fee_per_side_sats);
    let buyer_receives_sats = trade_sats.saturating_sub(fee_per_side_sats);

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
        seller_hold_invoice_sats,
        buyer_receives_sats,
        seller_total_locked_sats: seller_hold_invoice_sats.saturating_add(seller_bond),
        buyer_total_locked_sats: buyer_bond,
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
    let escrow_hash = hash_hex(&format!("{}-seller-hold", order_id));
    let maker_bond_hash = hash_hex(&format!("{}-maker-bond", order_id));
    let taker_bond_hash = hash_hex(&format!("{}-taker-bond", order_id));
    let payout_hash = hash_hex(&format!("{}-buyer-payout", order_id));
    let dispute_id = format!("dsp-{}", &hash_hex(&format!("{}-dispute", order_id))[0..12]);

    let fin = &financials;
    let mut steps: Vec<SimulationStep> = Vec::new();
    let message = |from: &str, to: &str, summary: String| NostrEventSummary {
        kind: KIND_PROTOCOL_MESSAGE,
        event_id: String::new(),
        sender: from.into(),
        recipient: Some(to.into()),
        summary,
    };
    let public = |kind: u64, summary: String| NostrEventSummary {
        kind,
        event_id: String::new(),
        sender: bot.into(),
        recipient: None,
        summary,
    };
    let lightning = |action: &str, amount_sats: u64, hash: &str, status: &str| {
        Some(LightningActionSummary {
            action: action.into(),
            amount_sats,
            payment_hash: hash.into(),
            status: status.into(),
        })
    };
    let mut push = |action_code: &str,
                    title: &str,
                    actor: Actor,
                    order_status: &str,
                    description: String,
                    nostr_event: Option<NostrEventSummary>,
                    lightning_action: Option<LightningActionSummary>| {
        let step_number = steps.len() + 1;
        steps.push(SimulationStep {
            step_number,
            action_code: action_code.into(),
            title: title.into(),
            actor,
            order_status: order_status.into(),
            description,
            nostr_event: nostr_event.map(|mut event| {
                event.event_id = hash_hex(&format!("{order_id}-step-{step_number}"));
                event
            }),
            lightning_action,
        });
    };

    // 1. The maker asks the daemon to publish the order. Nothing is locked yet
    //    except, when the node requires it, the maker's bond.
    push(
        "new_order",
        "Creación de la orden de venta (new-order)",
        Actor::Seller,
        if fin.seller_bond_sats > 0 {
            "waiting-maker-bond"
        } else {
            "pending"
        },
        format!(
            "El vendedor pide publicar una orden para vender {} sats por {} {} mediante {}. Envía importe fijo en sats y prima 0: Mostro rechaza una orden que combine sats fijos con una prima distinta de cero.",
            fin.trade_amount_sats, fin.fiat_amount, fin.fiat_currency, payment_method
        ),
        Some(message(
            seller_npub,
            bot,
            format!("new-order: venta de {} sats", fin.trade_amount_sats),
        )),
        None,
    );
    if fin.seller_bond_sats > 0 {
        push(
            "maker_bond_accepted",
            "Garantía del creador de la orden",
            Actor::Seller,
            "waiting-maker-bond",
            format!(
                "Mostro envía al vendedor una factura retenida de garantía por {} sats (pay-bond-invoice). La orden no se publica hasta que la paga; la garantía es una factura distinta del depósito de la operación.",
                fin.seller_bond_sats
            ),
            Some(message(
                bot,
                seller_npub,
                format!("pay-bond-invoice: {} sats", fin.seller_bond_sats),
            )),
            lightning(
                "MakerBondHoldInvoiceAccepted",
                fin.seller_bond_sats,
                &maker_bond_hash,
                "ACCEPTED",
            ),
        );
    }
    push(
        "order_published",
        "Publicación de la orden en los relays",
        Actor::Mostro,
        "pending",
        "Mostro confirma la orden al vendedor y publica el evento público de la orden (kind 38383) con estado pending. Todavía no existe depósito: se crea cuando alguien toma la orden.".into(),
        Some(public(
            KIND_ORDER,
            format!(
                "Orden pending: venta de {} sats por {} {}",
                fin.trade_amount_sats, fin.fiat_amount, fin.fiat_currency
            ),
        )),
        None,
    );

    if scenario == SimulationScenario::SellerCancellation {
        push(
            "cancel_order",
            "Cancelación de la orden por el vendedor (cancel)",
            Actor::Seller,
            "canceled",
            if fin.seller_bond_sats > 0 {
                format!(
                    "El vendedor cancela antes de que nadie tome la orden. No hay depósito que devolver; Mostro cancela la factura de garantía de {} sats y el vendedor recupera esos fondos sin coste.",
                    fin.seller_bond_sats
                )
            } else {
                "El vendedor cancela antes de que nadie tome la orden. No hay depósito ni garantía bloqueados, así que no se mueve ningún sat.".into()
            },
            Some(message(seller_npub, bot, "cancel".into())),
            if fin.seller_bond_sats > 0 {
                lightning(
                    "MakerBondHoldInvoiceCanceled",
                    fin.seller_bond_sats,
                    &maker_bond_hash,
                    "CANCELED",
                )
            } else {
                None
            },
        );

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

    // 2. A buyer takes the order.
    push(
        "take_sell",
        "El comprador toma la orden (take-sell)",
        Actor::Buyer,
        if fin.buyer_bond_sats > 0 {
            "waiting-taker-bond"
        } else {
            "waiting-buyer-invoice"
        },
        if fin.buyer_bond_sats > 0 {
            "El comprador envía take-sell a Mostro. En los relays la orden sigue anunciada como pending hasta que el comprador paga su garantía.".to_string()
        } else {
            "El comprador envía take-sell a Mostro, que fija los sats de la operación y pasa la orden a in-progress en los relays.".to_string()
        },
        Some(message(buyer_npub, bot, format!("take-sell: {order_id}"))),
        None,
    );
    if fin.buyer_bond_sats > 0 {
        push(
            "taker_bond_accepted",
            "Garantía del comprador",
            Actor::Buyer,
            "waiting-taker-bond",
            format!(
                "Mostro envía al comprador una factura retenida de garantía por {} sats (pay-bond-invoice) y el comprador la paga. No incluye comisión: la del comprador se descuenta de lo que recibe. Con la garantía pagada, la orden pasa a in-progress en los relays.",
                fin.buyer_bond_sats
            ),
            Some(message(
                bot,
                buyer_npub,
                format!("pay-bond-invoice: {} sats", fin.buyer_bond_sats),
            )),
            lightning(
                "BuyerBondHoldInvoiceAccepted",
                fin.buyer_bond_sats,
                &taker_bond_hash,
                "ACCEPTED",
            ),
        );
    }
    push(
        "add_invoice",
        "Factura de cobro del comprador (add-invoice)",
        Actor::Buyer,
        "waiting-buyer-invoice",
        format!(
            "Mostro pide al comprador una factura Lightning por {} sats: los {} sats de la operación menos su mitad de la comisión ({} sats). El comprador la envía con add-invoice.",
            fin.buyer_receives_sats, fin.trade_amount_sats, fin.fee_per_side_sats
        ),
        Some(message(
            buyer_npub,
            bot,
            format!("add-invoice: factura de {} sats", fin.buyer_receives_sats),
        )),
        None,
    );

    // 3. Escrow: created only now, and it is the seller who funds it.
    push(
        "hold_invoice_created",
        "Depósito del vendedor (pay-invoice)",
        Actor::Mostro,
        "waiting-payment",
        format!(
            "Mostro envía al vendedor la factura retenida del depósito por {} sats: {} sats de la operación más su mitad de la comisión ({} sats).",
            fin.seller_hold_invoice_sats, fin.trade_amount_sats, fin.fee_per_side_sats
        ),
        Some(message(
            bot,
            seller_npub,
            format!("pay-invoice: {} sats", fin.seller_hold_invoice_sats),
        )),
        lightning(
            "HoldInvoiceCreated",
            fin.seller_hold_invoice_sats,
            &escrow_hash,
            "OPEN",
        ),
    );
    push(
        "hold_invoice_accepted",
        "Fondos del vendedor retenidos",
        Actor::Seller,
        "active",
        "El vendedor paga la factura retenida. Los sats quedan bloqueados en su canal, sin llegar a Mostro, y la operación pasa a active: Mostro avisa a ambas partes y les da la clave de la contraparte para hablar entre ellos.".into(),
        Some(message(
            bot,
            buyer_npub,
            "hold-invoice-payment-accepted".into(),
        )),
        lightning(
            "HoldInvoiceAccepted",
            fin.seller_hold_invoice_sats,
            &escrow_hash,
            "ACCEPTED",
        ),
    );

    // 4. Fiat leg, off-chain between the parties.
    push(
        "fiat_sent",
        "El comprador avisa del pago fiat (fiat-sent)",
        Actor::Buyer,
        "fiat-sent",
        format!(
            "El comprador paga {} {} por {} fuera de Mostro y envía fiat-sent. Mostro se lo comunica al vendedor (fiat-sent-ok).",
            fin.fiat_amount, fin.fiat_currency, payment_method
        ),
        Some(message(buyer_npub, bot, "fiat-sent".into())),
        None,
    );

    let release_bonds = |push: &mut PushStep<'_>, final_status: &str, release_taker: bool| {
        if fin.seller_bond_sats > 0 {
            push(
                "maker_bond_released",
                "Devolución de la garantía del vendedor",
                Actor::Mostro,
                final_status,
                format!(
                    "Mostro cancela la factura de garantía del vendedor: recupera sus {} sats íntegros.",
                    fin.seller_bond_sats
                ),
                None,
                lightning(
                    "MakerBondHoldInvoiceCanceled",
                    fin.seller_bond_sats,
                    &maker_bond_hash,
                    "CANCELED",
                ),
            );
        }
        if release_taker && fin.buyer_bond_sats > 0 {
            push(
                "taker_bond_released",
                "Devolución de la garantía del comprador",
                Actor::Mostro,
                final_status,
                format!(
                    "Mostro cancela la factura de garantía del comprador: recupera sus {} sats íntegros.",
                    fin.buyer_bond_sats
                ),
                None,
                lightning(
                    "BuyerBondHoldInvoiceCanceled",
                    fin.buyer_bond_sats,
                    &taker_bond_hash,
                    "CANCELED",
                ),
            );
        }
    };

    let (final_status, duration_simulated_ms) = match scenario {
        SimulationScenario::HappyPath => {
            push(
                "release",
                "El vendedor confirma el cobro y libera (release)",
                Actor::Seller,
                "settled-hold-invoice",
                format!(
                    "El vendedor comprueba que recibió {} {} y envía release. Mostro cobra la factura retenida: los {} sats pasan al nodo.",
                    fin.fiat_amount, fin.fiat_currency, fin.seller_hold_invoice_sats
                ),
                Some(message(seller_npub, bot, "release".into())),
                lightning(
                    "SellerHoldInvoiceSettled",
                    fin.seller_hold_invoice_sats,
                    &escrow_hash,
                    "SETTLED",
                ),
            );
            push(
                "success",
                "Pago al comprador y cierre",
                Actor::Mostro,
                "success",
                format!(
                    "Mostro paga {} sats a la factura del comprador y publica la orden como success. El nodo retiene {} sats de comisión ({} de cada parte), de los que {} sats se envían al fondo de desarrollo de Mostro cuando el nodo opera en mainnet.",
                    fin.buyer_receives_sats,
                    fin.total_mostro_fee_sats,
                    fin.fee_per_side_sats,
                    fin.dev_fee_sats
                ),
                Some(public(KIND_ORDER, "Orden success".into())),
                lightning(
                    "PayoutToBuyerDispatched",
                    fin.buyer_receives_sats,
                    &payout_hash,
                    "SUCCEEDED",
                ),
            );
            release_bonds(&mut push, "success", true);
            ("success", 3200)
        }
        SimulationScenario::DisputeSettledForBuyer => {
            push(
                "dispute_opened",
                "Apertura de disputa (dispute)",
                Actor::Buyer,
                "dispute",
                "El vendedor no libera tras recibir el pago y el comprador abre una disputa. Mostro avisa a ambas partes y publica el evento público de la disputa (kind 38386) con estado initiated; ese evento no nombra la orden.".into(),
                Some(public(
                    KIND_DISPUTE,
                    format!("Disputa {dispute_id} initiated, iniciada por el comprador"),
                )),
                None,
            );
            push(
                "admin_take_dispute",
                "Un solver toma la disputa (admin-take-dispute)",
                Actor::Solver,
                "dispute",
                "Un solver registrado en el nodo toma la disputa con su cliente de mediación. Mostro le entrega los datos de la orden y las claves de las partes para hablar con ellas, y la disputa pasa a in-progress.".into(),
                Some(message(
                    solver_npub,
                    bot,
                    format!("admin-take-dispute: {dispute_id}"),
                )),
                None,
            );
            push(
                "adm_settle",
                "El solver resuelve a favor del comprador (admin-settle)",
                Actor::Solver,
                "settled-by-admin",
                format!(
                    "Con las pruebas del pago fiat, el solver envía admin-settle. Mostro cobra la factura retenida del vendedor ({} sats) sin su intervención.",
                    fin.seller_hold_invoice_sats
                ),
                Some(message(
                    solver_npub,
                    bot,
                    format!("admin-settle: {order_id}"),
                )),
                lightning(
                    "SellerHoldInvoiceSettled",
                    fin.seller_hold_invoice_sats,
                    &escrow_hash,
                    "SETTLED",
                ),
            );
            push(
                "dispute_payout",
                "Pago al comprador tras la resolución",
                Actor::Mostro,
                "success",
                format!(
                    "Mostro paga {} sats a la factura del comprador, cierra la disputa como settled y publica la orden como success. La comisión de {} sats se cobra igual que en una operación normal.",
                    fin.buyer_receives_sats, fin.total_mostro_fee_sats
                ),
                Some(public(KIND_ORDER, "Orden success".into())),
                lightning(
                    "PayoutToBuyerDispatched",
                    fin.buyer_receives_sats,
                    &payout_hash,
                    "SUCCEEDED",
                ),
            );
            release_bonds(&mut push, "success", true);
            ("success_dispute_resolved", 4800)
        }
        SimulationScenario::DisputeRefundedToSeller => {
            push(
                "dispute_opened",
                "Apertura de disputa por falta de pago (dispute)",
                Actor::Seller,
                "dispute",
                "El comprador marcó el pago como enviado, pero el vendedor no lo recibe y abre una disputa. Mostro avisa a ambas partes y publica el evento público de la disputa (kind 38386) con estado initiated.".into(),
                Some(public(
                    KIND_DISPUTE,
                    format!("Disputa {dispute_id} initiated, iniciada por el vendedor"),
                )),
                None,
            );
            push(
                "admin_take_dispute",
                "Un solver toma la disputa (admin-take-dispute)",
                Actor::Solver,
                "dispute",
                "Un solver registrado en el nodo toma la disputa y pide al comprador el comprobante del pago. La disputa pasa a in-progress.".into(),
                Some(message(
                    solver_npub,
                    bot,
                    format!("admin-take-dispute: {dispute_id}"),
                )),
                None,
            );
            push(
                "adm_refund",
                "El solver devuelve los fondos al vendedor (admin-cancel)",
                Actor::Solver,
                "canceled-by-admin",
                format!(
                    "Sin comprobante válido, el solver envía admin-cancel. Mostro cancela la factura retenida y los {} sats vuelven al vendedor; nadie paga comisión. La orden se publica como canceled y la disputa como seller-refunded.",
                    fin.seller_hold_invoice_sats
                ),
                Some(message(
                    solver_npub,
                    bot,
                    format!("admin-cancel: {order_id}"),
                )),
                lightning(
                    "SellerHoldInvoiceCanceled",
                    fin.seller_hold_invoice_sats,
                    &escrow_hash,
                    "CANCELED",
                ),
            );
            if fin.buyer_bond_sats > 0 {
                push(
                    "buyer_bond_slashed",
                    "Ejecución de la garantía del comprador",
                    Actor::Mostro,
                    "canceled",
                    format!(
                        "El solver indica en su resolución que el comprador pierde la garantía. Mostro cobra esa factura de {} sats: el nodo conserva la mitad y el vendedor puede reclamar el resto con una factura propia.",
                        fin.buyer_bond_sats
                    ),
                    None,
                    lightning(
                        "BuyerBondHoldInvoiceSettled",
                        fin.buyer_bond_sats,
                        &taker_bond_hash,
                        "SETTLED",
                    ),
                );
            }
            release_bonds(&mut push, "canceled", false);
            ("refunded_to_seller", 5100)
        }
        SimulationScenario::SellerCancellation => unreachable!("handled above"),
    };

    Ok(SimulationReport {
        scenario,
        order_id,
        bot_npub: bot.into(),
        payment_method,
        financials,
        steps,
        final_status: final_status.into(),
        is_success: true,
        duration_simulated_ms,
        timestamp_unix: now_unix,
        simulation_mode: SIMULATION_MODE_LABEL.into(),
        disclaimer: SIMULATION_DISCLAIMER.into(),
    })
}

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
