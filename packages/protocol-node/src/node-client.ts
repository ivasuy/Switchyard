import type {
  AssignmentClaimRequest,
  AssignmentClaimResponse,
  AssignmentArtifactManifestRequest,
  AssignmentCompleteRequest,
  AssignmentEventSyncRequest,
  HttpErrorCode,
  HttpErrorDetail,
  NodeHeartbeatRequest,
  NodeRegisterRequest
} from "@switchyard/contracts";

export interface NodeClientOptions {
  baseUrl: string;
  nodeId?: string;
  sharedToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class NodeClientError extends Error {}
export class NodeClientTimeoutError extends NodeClientError {}
export class NodeClientNetworkError extends NodeClientError {}
export class NodeClientDecodeError extends NodeClientError {}
export class NodeClientHttpError extends NodeClientError {
  constructor(
    readonly status: number,
    readonly code: HttpErrorCode,
    message: string,
    readonly requestId?: string,
    readonly details?: HttpErrorDetail[]
  ) {
    super(message);
  }
}

export class NodeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: NodeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async register(input: NodeRegisterRequest): Promise<any> {
    return this.post("/nodes/register", input);
  }

  async heartbeat(nodeId: string, input: NodeHeartbeatRequest): Promise<any> {
    return this.post(`/nodes/${nodeId}/heartbeat`, input);
  }

  async claim(nodeId: string, input?: AssignmentClaimRequest | string): Promise<AssignmentClaimResponse> {
    if (typeof input === "string") {
      return this.post(`/nodes/${nodeId}/assignments/claim`, { assignmentId: input });
    }
    return this.post(`/nodes/${nodeId}/assignments/claim`, input ?? {});
  }

  async reject(nodeId: string, assignmentId: string, input: { reason: string }): Promise<any> {
    return this.post(`/nodes/${nodeId}/assignments/${assignmentId}/reject`, input);
  }

  async syncEvents(nodeId: string, assignmentId: string, input: AssignmentEventSyncRequest): Promise<any> {
    return this.post(`/nodes/${nodeId}/assignments/${assignmentId}/events`, input);
  }

  async syncArtifactManifest(nodeId: string, assignmentId: string, input: AssignmentArtifactManifestRequest): Promise<any> {
    return this.post(`/nodes/${nodeId}/assignments/${assignmentId}/artifacts/manifest`, input);
  }

  async syncArtifactContent(nodeId: string, assignmentId: string, artifactId: string, body: Buffer): Promise<any> {
    const response = await this.request(
      `${this.options.baseUrl}/nodes/${nodeId}/assignments/${assignmentId}/artifacts/${artifactId}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          ...this.authHeader()
        },
        body
      }
    );
    return parseJson(response);
  }

  async complete(nodeId: string, assignmentId: string, input: AssignmentCompleteRequest): Promise<any> {
    return this.post(`/nodes/${nodeId}/assignments/${assignmentId}/complete`, input);
  }

  private async post(path: string, payload: unknown): Promise<any> {
    const response = await this.request(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeader()
      },
      body: JSON.stringify(payload)
    });
    return parseJson(response);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal
      });
      if (!response.ok) {
        throw await parseHttpError(response);
      }
      return response;
    } catch (error) {
      if (error instanceof NodeClientError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new NodeClientTimeoutError("node_client_timeout");
      }
      throw new NodeClientNetworkError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private authHeader(): Record<string, string> {
    if (!this.options.sharedToken) return {};
    return { "x-switchyard-node-token": this.options.sharedToken };
  }
}

async function parseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch (error) {
    throw new NodeClientDecodeError(error instanceof Error ? error.message : "decode_failed");
  }
}

async function parseHttpError(response: Response): Promise<NodeClientHttpError> {
  let message = `http_${response.status}`;
  let code: HttpErrorCode = "internal_error";
  let requestId: string | undefined;
  let details: HttpErrorDetail[] | undefined;
  try {
    const body = await response.json() as {
      error?: { code?: HttpErrorCode; message?: string; requestId?: string; details?: HttpErrorDetail[] };
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    requestId = body.error?.requestId;
    if (Array.isArray(body.error?.details)) {
      details = body.error.details;
    }
  } catch {
    // keep fallback values
  }
  return new NodeClientHttpError(response.status, code, message, requestId, details);
}
