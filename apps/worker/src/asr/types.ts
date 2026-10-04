export type AsrSessionOptions = {
  sampleRate: 16000;
  language?: "auto" | "zh" | "en";
};
export type AsrSentence = {
  id: string;
  text: string;
  final: boolean;
  startedAt?: number;
  endedAt?: number;
};
export type AsrFailureReason =
  | "authentication"
  | "quota"
  | "configuration"
  | "capacity"
  | "network"
  | "protocol"
  | "timeout"
  | "provider";
export class AsrProviderError extends Error {
  constructor(
    readonly reason: AsrFailureReason,
    readonly retryable: boolean,
  ) {
    super("ASR connection failed");
    this.name = "AsrProviderError";
  }
}
/**
 * Classify an HTTP status from a provider handshake or token request into
 * the shared failure taxonomy: 401/403 are credential problems, `quotaStatus`
 * lets a provider name its own billing status (Dashscope bills as 402), 429
 * is retryable capacity, other 4xx are configuration, and anything else —
 * including a missing status — is treated as a retryable network failure.
 * The three streaming providers carried a copy each; only Dashscope's had
 * the extra quota branch.
 */
export function asrHttpFailure(status?: number, quotaStatus?: number) {
  if (status === 401 || status === 403)
    return new AsrProviderError("authentication", false);
  if (quotaStatus !== undefined && status === quotaStatus)
    return new AsrProviderError("quota", false);
  if (status === 429) return new AsrProviderError("capacity", true);
  if (status && status >= 400 && status < 500)
    return new AsrProviderError("configuration", false);
  return new AsrProviderError("network", true);
}
export const ASR_MAX_BUFFERED_BYTES = 64_000;
export function sendAsrAudio(socket: WebSocket, data: ArrayBuffer) {
  if (socket.bufferedAmount + data.byteLength > ASR_MAX_BUFFERED_BYTES)
    throw new AsrProviderError("capacity", true);
  socket.send(data);
}
export type AsrConnection = {
  sendAudio(data: ArrayBuffer): void;
  /** Resolves only after the provider has delivered all final results. */
  finish(): Promise<void>;
  close(): void;
};
export type StreamingAsrProvider = {
  /** Resolves only when audio can be sent. Abort also closes a pending upgrade. */
  connect(
    options: AsrSessionOptions,
    onSentence: (sentence: AsrSentence) => void,
    onError: (error: AsrProviderError) => void,
    signal: AbortSignal,
  ): Promise<AsrConnection>;
};
