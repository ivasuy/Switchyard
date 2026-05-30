import type {
  AssignmentClaimResponse,
  AssignmentArtifactManifestRequest,
  AssignmentCompleteRequest,
  AssignmentEventSyncRequest,
  NodeHeartbeatRequest,
  NodeRegisterRequest
} from "@switchyard/contracts";

export interface NodeClientOptions {
  baseUrl: string;
  nodeId?: string;
  sharedToken?: string;
  fetchImpl?: typeof fetch;
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

  async claim(nodeId: string, assignmentId?: string): Promise<AssignmentClaimResponse> {
    return this.post(`/nodes/${nodeId}/assignments/claim`, assignmentId ? { assignmentId } : {});
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
    const response = await this.fetchImpl(`${this.options.baseUrl}/nodes/${nodeId}/assignments/${assignmentId}/artifacts/${artifactId}/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...this.authHeader()
      },
      body
    });
    return response.json();
  }

  async complete(nodeId: string, assignmentId: string, input: AssignmentCompleteRequest): Promise<any> {
    return this.post(`/nodes/${nodeId}/assignments/${assignmentId}/complete`, input);
  }

  private async post(path: string, payload: unknown): Promise<any> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeader()
      },
      body: JSON.stringify(payload)
    });
    return response.json();
  }

  private authHeader(): Record<string, string> {
    if (!this.options.sharedToken) return {};
    return { "x-switchyard-node-token": this.options.sharedToken };
  }
}
