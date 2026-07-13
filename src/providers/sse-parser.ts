export interface ServerSentEvent {
  id?: string;
  event?: string;
  data: string;
  comments: string[];
  retry?: number;
}

export interface SseParserOptions {
  maxEventBytes?: number;
}

/** Incremental UTF-8 SSE parser supporting arbitrary network fragmentation. */
export class SseParser {
  private readonly decoder = new TextDecoder();
  private readonly maxEventBytes: number;
  private buffer = "";
  private dataLines: string[] = [];
  private comments: string[] = [];
  private id: string | undefined;
  private event: string | undefined;
  private retry: number | undefined;
  private currentBytes = 0;
  private firstChunk = true;

  public constructor(options: SseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? 1_048_576;
    if (!Number.isInteger(this.maxEventBytes) || this.maxEventBytes < 1) {
      throw new Error("SSE event byte limit must be a positive integer");
    }
  }

  public push(chunk: Uint8Array | string): ServerSentEvent[] {
    const text =
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, {
            stream: true
          });
    this.buffer += this.stripInitialBom(text);
    this.assertWithinLimit();
    return this.consumeCompleteLines();
  }

  public finish(): ServerSentEvent[] {
    this.buffer += this.decoder.decode();
    this.assertWithinLimit();
    const events = this.consumeCompleteLines(true);
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
    const finalEvent = this.dispatch();
    if (finalEvent) events.push(finalEvent);
    return events;
  }

  private stripInitialBom(text: string): string {
    if (!this.firstChunk) return text;
    if (text === "") return text;
    this.firstChunk = false;
    return text.startsWith("\uFEFF") ? text.slice(1) : text;
  }

  private consumeCompleteLines(final = false): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    while (true) {
      const match = /\r|\n/.exec(this.buffer);
      if (!match || match.index === undefined) break;
      if (!final && match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      const terminatorLength = match[0] === "\r" && this.buffer[match.index + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(match.index + terminatorLength);
      if (line === "") {
        const event = this.dispatch();
        if (event) events.push(event);
      } else {
        this.consumeLine(line);
      }
    }
    return events;
  }

  private consumeLine(line: string): void {
    this.currentBytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.currentBytes > this.maxEventBytes) {
      throw new Error("SSE event exceeded the configured byte limit");
    }
    if (line.startsWith(":")) {
      this.comments.push(line.slice(1).replace(/^ /, ""));
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (/^\d+$/.test(value) && Number.isSafeInteger(parsed)) this.retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  private dispatch(): ServerSentEvent | undefined {
    const hasFrame =
      this.dataLines.length > 0 ||
      this.comments.length > 0 ||
      this.id !== undefined ||
      this.event !== undefined ||
      this.retry !== undefined;
    if (!hasFrame) return undefined;
    const result: ServerSentEvent = {
      data: this.dataLines.join("\n"),
      comments: [...this.comments],
      ...(this.id !== undefined ? { id: this.id } : {}),
      ...(this.event !== undefined ? { event: this.event } : {}),
      ...(this.retry !== undefined ? { retry: this.retry } : {})
    };
    this.dataLines = [];
    this.comments = [];
    this.id = undefined;
    this.event = undefined;
    this.retry = undefined;
    this.currentBytes = 0;
    return result;
  }

  private assertWithinLimit(): void {
    if (this.currentBytes + Buffer.byteLength(this.buffer, "utf8") > this.maxEventBytes) {
      throw new Error("SSE event exceeded the configured byte limit");
    }
  }
}
