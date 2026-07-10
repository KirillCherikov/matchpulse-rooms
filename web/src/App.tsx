import { useCallback, useEffect, useState, type JSX } from "react";
import type {
  AgentStatus,
  Analytics,
  AuditEvent,
  OperationalAlert,
  PaperPosition,
  Signal
} from "../../src/domain/models";

interface DashboardData {
  status?: AgentStatus;
  signals: Signal[];
  alerts: OperationalAlert[];
  positions: PaperPosition[];
  analytics?: Analytics;
  audit: AuditEvent[];
  error?: string;
}

const emptyData: DashboardData = { signals: [], alerts: [], positions: [], audit: [] };

export function App(): JSX.Element {
  const signalId = signalIdFromPath();
  return signalId ? <SignalDetail id={signalId} /> : <Dashboard />;
}

function Dashboard(): JSX.Element {
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [speed, setSpeed] = useState<1 | 2 | 5 | 10>(1);
  const [controlError, setControlError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const status = await get<AgentStatus>("/api/agent/status");
      const [signals, alerts, positions, analytics, audit] = await Promise.all([
        get<{ signals: Signal[] }>("/api/signals"),
        get<{ alerts: OperationalAlert[] }>("/api/alerts"),
        get<{ positions: PaperPosition[] }>("/api/positions"),
        get<{ analytics: Analytics }>("/api/analytics"),
        get<{ events: AuditEvent[] }>("/api/audit?limit=14")
      ]);
      setData({
        status,
        signals: signals.signals,
        alerts: alerts.alerts,
        positions: positions.positions,
        analytics: analytics.analytics,
        audit: audit.events
      });
      setControlError(undefined);
    } catch (error) {
      setData((current) => ({ ...current, error: message(error) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const control = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      try {
        const request: RequestInit = {
          method: "POST",
          ...(body
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {})
        };
        const response = await fetch(path, request);
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Control request failed (${response.status})`);
        }
        await refresh();
      } catch (error) {
        setControlError(message(error));
      }
    },
    [refresh]
  );

  const status = data.status;
  const fixture = status?.fixture;
  const replay = status?.replay;
  const latestSignal = status?.latestSignal;
  const latestOdds = status?.latestOdds;
  const latestEvent = status?.latestConfirmedEvent;
  const feedHealth = status?.feedHealth.status ?? "unknown";
  const latestMovement = latestSignal?.movement;
  const modeLabel = status?.mode?.toUpperCase() ?? "CONNECTING";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">TXLINE SENTINEL</p>
          <h1>Explainable market operations console</h1>
          <p className="subtle">
            Real-time sports market intelligence with deterministic replay and auditability.
          </p>
        </div>
        <div className="header-status">
          <span className={`status-pill ${status?.ready ? "positive" : "warning"}`}>
            {modeLabel}
          </span>
          <strong>SIMULATION ONLY — NO REAL MONEY</strong>
        </div>
      </header>

      {data.error ? <p className="error-banner">API unavailable: {data.error}</p> : null}
      {controlError ? <p className="error-banner">Replay control failed: {controlError}</p> : null}
      {fixture?.dataLabel ? <p className="demo-label">{fixture.dataLabel}</p> : null}

      <section className="overview-grid">
        <MetricCard
          label="Agent status"
          value={replay?.status ?? (loading ? "Loading" : "Idle")}
          detail={`Mode: ${modeLabel}`}
          tone={status?.ready ? "positive" : "warning"}
        />
        <MetricCard
          label="Current fixture"
          value={
            fixture
              ? `${fixture.homeTeam} ${fixture.score.home}–${fixture.score.away} ${fixture.awayTeam}`
              : "No fixture"
          }
          detail={
            fixture
              ? `${fixture.competition} · ${fixture.minute}' · ${fixture.status}`
              : "Waiting for provider"
          }
        />
        <MetricCard
          label="Feed health"
          value={feedHealth.toUpperCase()}
          detail={
            feedHealth === "degraded"
              ? "At least one feed is currently stale"
              : feedHealth === "healthy"
                ? "Score and odds feeds are currently healthy"
                : "Waiting for both feeds"
          }
          tone={
            feedHealth === "degraded"
              ? "negative"
              : feedHealth === "unknown"
                ? "warning"
                : "positive"
          }
        />
        <MetricCard
          label="Latest feed latency"
          value={
            latestOdds
              ? `${Math.max(0, new Date(latestOdds.receivedTimestamp).getTime() - new Date(latestOdds.sourceTimestamp).getTime())} ms`
              : "—"
          }
          detail={latestOdds ? `Odds sequence ${latestOdds.sequence}` : "No normalized snapshot"}
        />
      </section>

      <section className="control-panel panel">
        <div>
          <p className="panel-kicker">Deterministic replay</p>
          <h2>
            {replay
              ? `${replay.cursor} / ${replay.totalEvents} source events`
              : "Replay controls unavailable"}
          </h2>
          <p className="subtle">The same input sequence produces the same auditable decisions.</p>
        </div>
        <div className="control-actions">
          <label>
            Speed
            <select
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value) as 1 | 2 | 5 | 10)}
            >
              {[1, 2, 5, 10].map((option) => (
                <option key={option} value={option}>
                  {option}x
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void control("/api/replay/start", { speed })}>Start</button>
          <button className="secondary" onClick={() => void control("/api/replay/pause")}>
            Pause
          </button>
          <button
            className="secondary"
            onClick={() => void control("/api/replay/resume", { speed })}
          >
            Resume
          </button>
          <button className="secondary" onClick={() => void control("/api/replay/advance")}>
            Next event
          </button>
          <button className="danger-outline" onClick={() => void control("/api/replay/reset")}>
            Reset
          </button>
        </div>
      </section>

      <section className="detail-grid">
        <article className="panel signal-panel">
          <p className="panel-kicker">Latest movement</p>
          <h2>
            {latestSignal
              ? `${formatSelection(latestSignal.selection)} ${formatSigned(latestSignal.movement.percentagePointMovement)} pp`
              : "No material movement yet"}
          </h2>
          <dl className="facts">
            <div>
              <dt>Normalized probability</dt>
              <dd>
                {latestSignal
                  ? `${percent(latestSignal.normalizedProbabilityBefore)} → ${percent(latestSignal.normalizedProbabilityAfter)}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Velocity</dt>
              <dd>
                {latestMovement ? `${latestMovement.velocityPerSecond.toFixed(4)} / sec` : "—"}
              </dd>
            </div>
            <div>
              <dt>Overround</dt>
              <dd>{latestOdds ? percent(latestOdds.overround) : "—"}</dd>
            </div>
            <div>
              <dt>Rule-based confidence score</dt>
              <dd>{latestSignal ? percent(latestSignal.ruleBasedConfidenceScore) : "—"}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <p className="panel-kicker">Latest confirmed match event</p>
          <h2>
            {latestEvent
              ? `${latestEvent.type.replaceAll("_", " ")} · ${latestEvent.minute}'`
              : "No event received"}
          </h2>
          <p className="subtle">
            {latestEvent?.confirmed
              ? "Confirmed score-feed event."
              : "Only confirmed events can explain a signal."}
          </p>
          <div className="event-score">
            {latestEvent?.score ? `${latestEvent.score.home} – ${latestEvent.score.away}` : "—"}
          </div>
        </article>

        <article className="panel explanation-panel">
          <p className="panel-kicker">Explainable decision</p>
          <h2>
            {latestSignal?.paperDecision === "opened"
              ? "Simulated confirmation position opened"
              : "No eligible paper action"}
          </h2>
          <p>
            {latestSignal?.explanation.summary ??
              "Replay will evaluate movements against typed thresholds."}
          </p>
          {latestSignal ? (
            <>
              <p className="subtle">
                {latestSignal.explanation.confirmedEvent ?? "Unexplained market movement"}
              </p>
              <ul className="reason-list">
                {latestSignal.explanation.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <a className="detail-link" href={`/signals/${latestSignal.id}`}>
                Open signal detail →
              </a>
            </>
          ) : null}
        </article>
      </section>

      <section className="analytics-grid">
        <MetricCard
          label="Virtual P&L"
          value={currency(data.analytics?.virtualPnl)}
          detail="Paper settlement only"
          tone={(data.analytics?.virtualPnl ?? 0) >= 0 ? "positive" : "negative"}
        />
        <MetricCard
          label="Open exposure"
          value={currency(data.analytics?.openExposure)}
          detail="Strict simulated risk cap"
        />
        <MetricCard
          label="Paper win rate"
          value={percent(data.analytics?.winRate)}
          detail={`${data.analytics?.settledPositions ?? 0} settled paper positions`}
        />
        <MetricCard
          label="Signal persistence (60s)"
          value={percent(data.analytics?.signalPrecision)}
          detail="Observed counterfactual horizon"
        />
        <MetricCard
          label="Maximum drawdown"
          value={currency(data.analytics?.maximumDrawdown)}
          detail={percent(data.analytics?.maximumDrawdownPercent)}
          tone="warning"
        />
      </section>

      <section className="table-grid">
        <article className="panel table-panel">
          <div className="section-heading">
            <div>
              <p className="panel-kicker">Operational alerts</p>
              <h2>Data-quality sentinel</h2>
            </div>
            <span>{data.alerts.length}</span>
          </div>
          <AlertTable alerts={data.alerts} />
        </article>
        <article className="panel table-panel">
          <div className="section-heading">
            <div>
              <p className="panel-kicker">Paper positions</p>
              <h2>Virtual execution ledger</h2>
            </div>
            <span>{data.positions.length}</span>
          </div>
          <PositionTable positions={data.positions} />
        </article>
      </section>

      <section className="panel timeline-panel">
        <div className="section-heading">
          <div>
            <p className="panel-kicker">Append-only audit</p>
            <h2>Decision timeline</h2>
          </div>
          <span>{status?.auditEvents ?? 0} events</span>
        </div>
        <ol className="timeline">
          {data.audit
            .slice()
            .reverse()
            .map((event) => (
              <li key={event.id}>
                <time>{time(event.timestamp)}</time>
                <div>
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  <span>{event.correlationId}</span>
                </div>
              </li>
            ))}
          {data.audit.length === 0 ? (
            <li className="empty">Replay audit events will appear here.</li>
          ) : null}
        </ol>
      </section>
    </main>
  );
}

function SignalDetail({ id }: { id: string }): JSX.Element {
  const [signal, setSignal] = useState<Signal>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void get<Signal>(`/api/signals/${id}`)
      .then(setSignal)
      .catch((reason: unknown) => setError(message(reason)));
  }, [id]);

  if (error)
    return (
      <main className="app-shell">
        <p className="error-banner">{error}</p>
        <a className="detail-link" href="/">
          ← Back to console
        </a>
      </main>
    );
  if (!signal)
    return (
      <main className="app-shell">
        <p className="subtle">Loading signal detail…</p>
      </main>
    );
  return (
    <main className="app-shell detail-page">
      <a className="detail-link" href="/">
        ← Back to console
      </a>
      <header className="detail-header">
        <p className="eyebrow">SIGNAL DETAIL · {signal.id}</p>
        <h1>
          {formatSelection(signal.selection)} movement at {signal.matchMinute}'
        </h1>
        <p className="subtle">{signal.explanation.summary}</p>
      </header>
      <section className="detail-grid">
        <article className="panel">
          <p className="panel-kicker">Evidence</p>
          <h2>{formatSigned(signal.movement.percentagePointMovement)} percentage points</h2>
          <dl className="facts">
            <div>
              <dt>Decimal odds</dt>
              <dd>
                {signal.oddsBefore.toFixed(2)} → {signal.oddsAfter.toFixed(2)}
              </dd>
            </div>
            <div>
              <dt>Rule-based confidence score</dt>
              <dd>{percent(signal.ruleBasedConfidenceScore)}</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>{signal.latencyMs} ms</dd>
            </div>
            <div>
              <dt>Rules</dt>
              <dd>{signal.triggeredRules.length}</dd>
            </div>
          </dl>
        </article>
        <article className="panel">
          <p className="panel-kicker">Correlation</p>
          <h2>
            {signal.correlatedEvent
              ? `${signal.correlatedEvent.event.type.replaceAll("_", " ")} at ${signal.correlatedEvent.event.minute}' · ${signal.correlatedEvent.relationship.replaceAll("_", " ")}`
              : "Unexplained market movement"}
          </h2>
          <p className="subtle">{signal.explanation.dataQuality}</p>
          <ul className="reason-list">
            {signal.explanation.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </article>
        <article className="panel">
          <p className="panel-kicker">Counterfactual</p>
          <h2>
            {signal.counterfactual.movementAssessment
              ? `Movement ${signal.counterfactual.movementAssessment}`
              : "Awaiting 60-second horizon"}
          </h2>
          <p>Immediate entry: {signal.counterfactual.immediateEntryOdds.toFixed(2)}</p>
          <p>
            Confirmation entry: {signal.counterfactual.confirmationEntryOdds?.toFixed(2) ?? "—"}
          </p>
          <p>Entry comparison: {signal.counterfactual.betterEntry?.replaceAll("_", " ") ?? "—"}</p>
          <p className="subtle">
            Settled unit returns: immediate {formatReturn(signal.counterfactual.immediateReturn)} ·
            confirmation {formatReturn(signal.counterfactual.confirmationReturn)}
          </p>
          <div className="horizon-list">
            {signal.counterfactual.horizons.map((point) => (
              <p key={point.horizonSeconds}>
                <strong>{point.horizonSeconds}s</strong> {point.classification} · retained{" "}
                {(point.retainedMovementRatio * 100).toFixed(0)}% · lag{" "}
                {point.observationLagSeconds.toFixed(0)}s
              </p>
            ))}
          </div>
        </article>
      </section>
      <section className="panel timeline-panel">
        <p className="panel-kicker">Outcome</p>
        <h2>
          {signal.outcome
            ? `${signal.outcome.positionOutcome ?? "No position"} · ${currency(signal.outcome.virtualPnl)}`
            : "Awaiting settlement"}
        </h2>
        <p className="subtle">SIMULATION ONLY — NO REAL MONEY</p>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = "neutral"
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "positive" | "warning" | "negative";
}): JSX.Element {
  return (
    <article className={`metric-card ${tone}`}>
      <p>{label}</p>
      <h2>{value}</h2>
      <span>{detail}</span>
    </article>
  );
}

function AlertTable({ alerts }: { alerts: OperationalAlert[] }): JSX.Element {
  if (alerts.length === 0) return <p className="empty">No operational alerts.</p>;
  return (
    <div className="compact-table">
      {alerts
        .slice()
        .reverse()
        .slice(0, 6)
        .map((alert) => (
          <div key={alert.id}>
            <span className={`severity ${alert.severity}`}>{alert.severity}</span>
            <p>
              <strong>{alert.type.replaceAll("_", " ")}</strong>
              {alert.message}
            </p>
            <time>{time(alert.timestamp)}</time>
          </div>
        ))}
    </div>
  );
}

function PositionTable({ positions }: { positions: PaperPosition[] }): JSX.Element {
  if (positions.length === 0) return <p className="empty">No paper positions have been opened.</p>;
  return (
    <div className="compact-table">
      {positions
        .slice()
        .reverse()
        .map((position) => (
          <div key={position.id}>
            <span className={`severity ${position.status === "settled" ? "info" : "warning"}`}>
              {position.status}
            </span>
            <p>
              <strong>
                {formatSelection(position.selection)} · {currency(position.stake)}
              </strong>
              {position.outcome
                ? `${position.outcome} · ${currency(position.virtualPnl)}`
                : `entry ${position.entryOdds.toFixed(2)}`}
            </p>
            <time>{time(position.openedAt)}</time>
          </div>
        ))}
    </div>
  );
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function signalIdFromPath(): string | undefined {
  const match = window.location.pathname.match(/^\/signals\/([^/]+)$/);
  return match?.[1];
}

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}
function currency(value: number | undefined): string {
  return value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)} virtual units`;
}
function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
function formatSelection(value: Signal["selection"]): string {
  return value === "home" ? "Home win" : value === "away" ? "Away win" : "Draw";
}
function formatReturn(value: number | undefined): string {
  return value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}
function time(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
