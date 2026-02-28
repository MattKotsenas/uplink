import {
  createNotification,
  createRequest,
  parseMessage,
} from "../shared/acp-types";
import type {
  AgentCapabilities,
  AvailableModel,
  ClientCapabilities,
  InitializeResult,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionOutcome,
  SessionCancelParams,
  SessionLoadParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionRequestPermissionParams as PermissionRequestParams,
  SessionUpdate,
  SessionUpdateParams,
  StopReason,
} from "../shared/acp-types";

const REQUEST_TIMEOUT_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PROTOCOL_VERSION = 1;
const CLIENT_CAPABILITIES: ClientCapabilities = {};
const CLIENT_INFO = {
  name: "uplink",
  title: "Copilot Uplink",
  version: "0.1.0",
} as const;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

type StartCallbacks = {
  onReady?: () => void;
  onError?: (error: Error) => void;
};

export type PermissionRequestContext = PermissionRequestParams & { id: number };

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "initializing"
  | "ready"
  | "prompting";

export interface AcpClientOptions {
  wsUrl: string;
  cwd: string;
  onStateChange?: (state: ConnectionState) => void;
  onSessionUpdate?: (update: SessionUpdate) => void;
  onModelsAvailable?: (models: AvailableModel[], currentModelId?: string) => void;
  onPermissionRequest?: (
    request: PermissionRequestContext,
    respond: (outcome: PermissionOutcome) => void,
  ) => void;
  onError?: (error: Error) => void;
}

export type {
  PermissionOutcome,
  SessionUpdate,
  StopReason,
  SessionRequestPermissionParams as PermissionRequestParams,
} from "../shared/acp-types";

export class AcpClient {
  private state: ConnectionState = "disconnected";
  private ws?: WebSocket;
  private sessionId?: string;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private connectPromise?: Promise<void>;
  private agentCapabilities: AgentCapabilities = {};

  constructor(private readonly options: AcpClientOptions) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  get supportsLoadSession(): boolean {
    return this.agentCapabilities.loadSession === true;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  connect(): Promise<void> {
    if (this.state === "ready" || this.state === "prompting") {
      return Promise.resolve();
    }

    this.shouldReconnect = true;
    this.clearReconnectTimer();
    return this.establishConnection();
  }

  async loadSession(sessionId: string): Promise<void> {
    this.ensureReadyState();
    await this.sendRequest("session/load", {
      sessionId,
      cwd: this.options.cwd,
      mcpServers: [],
    } satisfies SessionLoadParams);
    this.sessionId = sessionId;
    localStorage.setItem('uplink-resume-session', sessionId);
  }

  async prompt(text: string): Promise<StopReason> {
    this.ensureReadyState();
    if (!this.sessionId) {
      throw new Error("ACP session has not been established");
    }

    this.setState("prompting");
    try {
      const params: SessionPromptParams = {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      };
      const result = await this.sendRequest<SessionPromptResult>(
        "session/prompt",
        params,
        0,
      );
      return result.stopReason;
    } finally {
      const currentState = this.state;
      if (currentState === "prompting") {
        this.setState("ready");
      }
    }
  }

  cancel(): void {
    if (!this.sessionId) {
      return;
    }
    this.sendNotification("session/cancel", {
      sessionId: this.sessionId,
    } satisfies SessionCancelParams);
  }

  /** Send a raw JSON-RPC request and return the result. Used for uplink-specific methods. */
  sendRawRequest<T>(method: string, params: unknown): Promise<T> {
    return this.sendRequest<T>(method, params);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.sessionId = undefined;

    if (this.ws) {
      this.ws.close();
    } else {
      this.setState("disconnected");
      this.rejectAllPendingRequests(new Error("Client disconnected"));
    }
  }

  private establishConnection(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.startWebSocket({
          onReady: () => resolve(),
          onError: (error) => reject(error),
        });
      } catch (error) {
        reject(error as Error);
      }
    }).finally(() => {
      this.connectPromise = undefined;
    });

    return this.connectPromise!;
  }

  private startWebSocket(callbacks?: StartCallbacks): void {
    if (this.ws) {
      const state = this.ws.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        return;
      }
    }

    try {
      const ws = new WebSocket(this.options.wsUrl);
      this.ws = ws;
      this.setState("connecting");

      ws.addEventListener("open", () => {
        if (this.ws !== ws) return; // stale socket
        this.handleOpen(callbacks);
      });
      ws.addEventListener("message", (event) => {
        if (this.ws !== ws) return;
        this.handleMessageEvent(event);
      });
      ws.addEventListener("close", () => {
        if (this.ws !== ws) return; // old socket closing after replacement
        this.handleClose();
        callbacks?.onError?.(new Error("WebSocket closed"));
      });
      ws.addEventListener("error", () => {
        if (this.ws !== ws) return;
        this.handleError(new Error("WebSocket encountered an error"));
      });
    } catch (error) {
      callbacks?.onError?.(error as Error);
      this.handleError(error as Error);
      this.setState("disconnected");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private handleOpen(callbacks?: StartCallbacks): void {
    this.clearReconnectTimer();
    this.setState("initializing");
    const wsOpenTime = performance.now();

    this.initializeSession()
      .then(() => {
        console.debug(`[timing] WS open → ready: ${(performance.now() - wsOpenTime).toFixed(0)}ms`);
        this.reconnectAttempts = 0;
        this.setState("ready");
        callbacks?.onReady?.();
      })
      .catch((error) => {
        try {
          callbacks?.onError?.(error);
        } catch (err) {
          console.error("Error in onError callback:", err);
        }
        this.handleError(error);
        this.ws?.close();
      });
  }

  private async initializeSession(): Promise<void> {
    const t0 = performance.now();

    const initResult = await this.sendRequest<InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    console.debug(`[timing] initialize: ${(performance.now() - t0).toFixed(0)}ms`);

    this.agentCapabilities = initResult.agentCapabilities ?? {};

    // Try to resume a saved session (e.g., after page reload)
    const resumeId = localStorage.getItem('uplink-resume-session');
    if (resumeId && this.agentCapabilities.loadSession) {
      try {
        const tLoad = performance.now();
        const loadResult = await this.sendRequest<SessionNewResult>("session/load", {
          sessionId: resumeId,
          cwd: this.options.cwd,
          mcpServers: [],
        });
        console.debug(`[timing] session/load: ${(performance.now() - tLoad).toFixed(0)}ms`);
        console.debug(`[timing] total initializeSession: ${(performance.now() - t0).toFixed(0)}ms`);
        this.sessionId = loadResult.sessionId ?? resumeId;
        if (loadResult.models?.availableModels) {
          localStorage.setItem('uplink-cached-models', JSON.stringify(loadResult.models));
          this.options.onModelsAvailable?.(loadResult.models.availableModels, loadResult.models.currentModelId);
        } else {
          this.restoreCachedModels();
        }
        return;
      } catch (err) {
        // session/load failed — clear stale key and fall through to new session
        console.debug('[resume] session/load failed:', err);
        localStorage.removeItem('uplink-resume-session');
      }
    }

    const tNew = performance.now();
    const result = await this.sendRequest<SessionNewResult>(
      "session/new",
      { cwd: this.options.cwd, mcpServers: [] },
    );
    console.debug(`[timing] session/new: ${(performance.now() - tNew).toFixed(0)}ms`);
    console.debug(`[timing] total initializeSession: ${(performance.now() - t0).toFixed(0)}ms`);
    this.sessionId = result.sessionId;
    localStorage.setItem('uplink-resume-session', result.sessionId);

    if (result.models?.availableModels) {
      localStorage.setItem('uplink-cached-models', JSON.stringify(result.models));
      this.options.onModelsAvailable?.(result.models.availableModels, result.models.currentModelId);
    }
  }

  private restoreCachedModels(): void {
    const cached = localStorage.getItem('uplink-cached-models');
    if (cached) {
      try {
        const models = JSON.parse(cached);
        if (models?.availableModels) {
          this.options.onModelsAvailable?.(models.availableModels, models.currentModelId);
        }
      } catch {
        localStorage.removeItem('uplink-cached-models');
      }
    }
  }

  private handleClose(): void {
    this.ws = undefined;
    this.sessionId = undefined;
    this.rejectAllPendingRequests(new Error("Connection closed"));
    this.setState("disconnected");

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) {
      return;
    }

    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** this.reconnectAttempts,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.establishConnection().catch(() => {
        // The close handler will schedule another reconnect attempt.
      });
    }, delay || BASE_BACKOFF_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleMessageEvent(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.handleError(new Error("Received non-text WebSocket message"));
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = parseMessage(event.data);
    } catch (error) {
      this.handleError(error as Error);
      return;
    }

    if ("result" in message || "error" in message) {
      this.handleResponse(message as JsonRpcResponse);
    } else if ("id" in message) {
      this.handleRequest(message as JsonRpcRequest);
    } else {
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    if ("error" in message) {
      pending.reject(this.createJsonRpcError(message));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method !== "session/update" || !message.params) {
      return;
    }

    const params = message.params as SessionUpdateParams;
    try {
      this.options.onSessionUpdate?.(params.update);
    } catch (err) {
      console.error("Error in onSessionUpdate callback:", err);
    }
  }

  private handleRequest(message: JsonRpcRequest): void {
    if (message.method === "session/request_permission") {
      this.handlePermissionRequest(message);
      return;
    }

    this.sendErrorResponse(
      message.id,
      -32601,
      `Unsupported method: ${message.method}`,
    );
  }

  private handlePermissionRequest(message: JsonRpcRequest): void {
    const params = message.params as PermissionRequestParams | undefined;
    const respond = this.createPermissionResponder(message.id);

    if (!params || typeof message.id !== "number") {
      respond({ outcome: "cancelled" });
      return;
    }

    if (this.options.onPermissionRequest) {
      let responded = false;
      const once = (outcome: PermissionOutcome) => {
        if (responded) {
          return;
        }
        responded = true;
        respond(outcome);
      };

      try {
        const request: PermissionRequestContext = { ...params, id: message.id };
        this.options.onPermissionRequest(request, once);
        return;
      } catch (error) {
        console.error("Error in onPermissionRequest callback:", error);
        this.handleError(error as Error);
      }
    }

    respond({ outcome: "cancelled" });
  }

  private createPermissionResponder(
    id: number | string,
  ): (outcome: PermissionOutcome) => void {
    const sessionContext = this.sessionId;
    return (outcome) => {
      if (!this.isSocketOpen()) {
        return;
      }

      if (this.sessionId !== sessionContext) {
        console.warn("Ignoring permission response for stale session");
        return;
      }

      this.ws!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { outcome },
        }),
      );
    };
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.isSocketOpen()) {
      return;
    }

    this.ws!.send(JSON.stringify(createNotification(method, params)));
  }

  private sendErrorResponse(id: number | string, code: number, message: string) {
    if (!this.isSocketOpen()) {
      return;
    }

    this.ws!.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      }),
    );
  }

  private sendRequest<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.isSocketOpen()) {
      return Promise.reject(new Error("WebSocket is not open"));
    }

    const id = this.nextRequestId++;
    const request = createRequest(id, method, params);

    const effectiveTimeoutMs = timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timeoutId =
        Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0
          ? setTimeout(() => {
              if (this.pendingRequests.delete(id)) {
                reject(new Error(`Request "${method}" timed out`));
              }
            }, effectiveTimeoutMs)
          : undefined;

      this.pendingRequests.set(id, {
        resolve: (value) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          resolve(value as T);
        },
        reject: (error) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          reject(error);
        },
        timeoutId,
      });

      this.ws!.send(JSON.stringify(request));
    });
  }

  private rejectAllPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    });
    this.pendingRequests.clear();
  }

  private createJsonRpcError(message: JsonRpcResponse): Error {
    if ("error" in message && message.error) {
      const error = new Error(message.error.message);
      (error as Error & { code?: number; data?: unknown }).code =
        message.error.code;
      (error as Error & { code?: number; data?: unknown }).data =
        message.error.data;
      return error;
    }

    return new Error("Unknown JSON-RPC error");
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }

    this.state = state;
    try {
      this.options.onStateChange?.(state);
    } catch (err) {
      console.error("Error in onStateChange callback:", err);
    }
  }

  private ensureReadyState(): void {
    if (this.state !== "ready") {
      throw new Error("ACP client is not ready");
    }
  }

  private handleError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch (err) {
      console.error("Error in onError callback:", err);
    }
  }

  private isSocketOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
