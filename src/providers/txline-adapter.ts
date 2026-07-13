import { createHash } from "node:crypto";
import type { LiveFixtureObservation, MatchEvent, MatchEventType } from "../domain/models.js";
import {
  txLineFixtureSchema,
  txLineOddsSchema,
  txLineScoreSchema,
  type TxLineOddsRecord,
  type TxLineScoreRecord
} from "./txline-schemas.js";

export interface AdaptedTxLineFixture {
  fixture: LiveFixtureObservation;
  sourceTimestamp: string;
  receivedTimestamp: string;
  rawReference: string;
}

export interface PreservedTxLineOdds {
  record: TxLineOddsRecord;
  sourceTimestamp: string;
  receivedTimestamp: string;
  rawReference: string;
  decimalConversion: "unavailable";
}

export function adaptTxLineFixture(
  rawRecord: unknown,
  receivedTimestamp: string
): AdaptedTxLineFixture {
  const record = txLineFixtureSchema.parse(rawRecord);
  assertIsoTimestamp(receivedTimestamp);
  const homeTeam = record.Participant1IsHome ? record.Participant1 : record.Participant2;
  const awayTeam = record.Participant1IsHome ? record.Participant2 : record.Participant1;
  const gameState = record.GameState ?? record.gameState;
  const sourceTimestamp = epochMillisToIso(record.Ts);
  const rawReference = `txline://fixtures/${record.FixtureId}/${record.Ts}`;
  return {
    fixture: {
      id: String(record.FixtureId),
      competition: record.Competition,
      homeTeam,
      awayTeam,
      status: gameState === 6 ? "cancelled" : gameState === 1 ? "scheduled" : "unknown",
      scheduledStartTimestamp: epochMillisToIso(record.StartTime),
      sourceTimestamp,
      receivedTimestamp,
      rawReference,
      dataLabel: "Live TxLINE devnet data"
    },
    sourceTimestamp,
    receivedTimestamp,
    rawReference
  };
}

/**
 * Preserve official integer prices without inventing a decimal scale. This
 * object intentionally cannot be passed to the internal odds signal engine.
 */
export function preserveTxLineOdds(
  rawRecord: unknown,
  receivedTimestamp: string
): PreservedTxLineOdds {
  const record = txLineOddsSchema.parse(rawRecord);
  assertIsoTimestamp(receivedTimestamp);
  return {
    record: structuredClone(record),
    sourceTimestamp: epochMillisToIso(record.Ts),
    receivedTimestamp,
    rawReference: oddsRawReference(record),
    decimalConversion: "unavailable"
  };
}

/**
 * Map only explicit, confirmed soccer event flags. Unsupported score actions
 * stay available as validated TxLINE records but are not fabricated into the
 * Sentinel event taxonomy.
 */
export function adaptTxLineScoreEvent(
  rawRecord: unknown,
  receivedTimestamp: string
): MatchEvent | undefined {
  const record = txLineScoreSchema.parse(rawRecord);
  assertIsoTimestamp(receivedTimestamp);
  if (record.confirmed !== true || !record.dataSoccer) return undefined;

  const candidates: Array<[boolean | undefined, MatchEventType]> = [
    [record.dataSoccer.Goal, "goal"],
    [record.dataSoccer.RedCard, "red_card"],
    [record.dataSoccer.Penalty, "penalty"],
    [record.dataSoccer.VAR, "var"]
  ];
  const eventTypes = candidates.filter(([active]) => active === true).map(([, type]) => type);
  if (eventTypes.length === 0) return undefined;
  // The official flags are independent optionals. More than one active flag is
  // a valid TxLINE record but has no unambiguous single Sentinel event mapping.
  if (eventTypes.length !== 1 || record.dataSoccer.Minutes === undefined) return undefined;
  const team = participantSide(record);
  if ((eventTypes[0] === "goal" || eventTypes[0] === "red_card") && !team) return undefined;
  const score = soccerScore(record);
  return {
    kind: "score",
    id: `${record.fixtureId}-${record.connectionId}-${record.seq}-${record.id}`,
    fixtureId: String(record.fixtureId),
    sequence: record.seq,
    sourceTimestamp: epochMillisToIso(record.ts),
    receivedTimestamp,
    type: eventTypes[0]!,
    minute: record.dataSoccer.Minutes,
    ...(team ? { team } : {}),
    ...(score ? { score } : {}),
    confirmed: true,
    rawReference: `txline://scores/${record.fixtureId}/${record.connectionId}/${record.seq}/${record.id}`
  };
}

export function scoreRawReference(record: TxLineScoreRecord): string {
  return `txline://scores/${record.fixtureId}/${record.connectionId}/${record.seq}/${record.id}`;
}

export function oddsRawReference(record: TxLineOddsRecord): string {
  const digest = createHash("sha256").update(record.MessageId).digest("hex").slice(0, 24);
  return `txline://odds/${record.FixtureId}/${record.Ts}/${digest}`;
}

export function epochMillisToIso(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("TxLINE timestamp is outside the ISO date range");
  return date.toISOString();
}

function soccerScore(record: TxLineScoreRecord): { home: number; away: number } | undefined {
  const participant1 = record.scoreSoccer?.Participant1.Total?.Goals;
  const participant2 = record.scoreSoccer?.Participant2.Total?.Goals;
  if (participant1 === undefined && participant2 === undefined) return undefined;
  if (participant1 === undefined || participant2 === undefined) return undefined;
  return record.participant1IsHome
    ? { home: participant1, away: participant2 }
    : { home: participant2, away: participant1 };
}

function participantSide(record: TxLineScoreRecord): "home" | "away" | undefined {
  const participant = record.dataSoccer?.Participant ?? record.participant;
  if (participant === undefined) return undefined;
  if (participant === record.participant1Id) return record.participant1IsHome ? "home" : "away";
  if (participant === record.participant2Id) return record.participant1IsHome ? "away" : "home";
  return undefined;
}

function assertIsoTimestamp(value: string): void {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new Error("Received timestamp must be an ISO-compatible date-time");
  }
}
