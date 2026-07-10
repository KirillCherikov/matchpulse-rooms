import type { OperationalAlert, Signal, SignalExplanation } from "../domain/models.js";

export function buildExplanation(signal: Signal, alerts: OperationalAlert[]): SignalExplanation {
  const direction = signal.movement.probabilityDelta >= 0 ? "increased" : "decreased";
  const confirmedEvent = signal.correlatedEvent
    ? `${formatEvent(signal.correlatedEvent.event.type)} at ${signal.correlatedEvent.event.minute}' (${signal.correlatedEvent.relationship.replaceAll("_", " ")}).`
    : undefined;
  const dataQuality =
    alerts.length === 0
      ? "No active data-quality warning was detected for this decision."
      : `${alerts.length} data-quality warning(s) were observed while evaluating this movement.`;
  const reasons = signal.triggeredRules.map((rule) => reasonFor(rule));
  return {
    summary: `${formatSelection(signal.selection)} normalized probability ${direction} by ${Math.abs(
      signal.movement.percentagePointMovement
    ).toFixed(1)} percentage points within the observed update interval.`,
    ...(confirmedEvent ? { confirmedEvent } : {}),
    dataQuality,
    decision:
      signal.paperDecision === "opened"
        ? "Open a simulated confirmation position."
        : "Do not open a paper position until confirmation and feed-quality conditions are met.",
    reasons
  };
}

function formatSelection(selection: Signal["selection"]): string {
  return selection === "home" ? "Home win" : selection === "away" ? "Away win" : "Draw";
}

function formatEvent(event: NonNullable<Signal["correlatedEvent"]>["event"]["type"]): string {
  return event.replaceAll("_", " ");
}

function reasonFor(rule: string): string {
  const messages: Record<string, string> = {
    absolute_probability_shift: "movement exceeded the absolute probability threshold",
    rapid_probability_shift: "movement velocity exceeded the configured threshold",
    abnormal_relative_to_baseline: "movement was abnormal relative to the rolling baseline",
    momentum_continuation: "successive updates continued in the same direction",
    market_reversal: "the latest update reversed the prior movement direction",
    temporally_associated_event: "a confirmed match event was available inside the causal window",
    confirmed_match_event: "the confirmed event preceded and supported the market reaction",
    event_consistent_movement: "the movement direction was consistent with the confirmed event",
    event_market_divergence: "the associated event did not support the selected movement direction",
    late_event_confirmation: "event confirmation arrived after the odds source timestamp",
    unexplained_market_movement: "no confirmed match event explained the movement",
    data_quality_warning: "a feed-quality warning reduced confidence"
  };
  return messages[rule] ?? rule;
}
