import { DeferredHttpWrapperAdapter } from "../wrapper-http/deferred-http-wrapper-adapter.js";
import type { DeferredHttpWrapperAdapterOptions } from "../wrapper-http/types.js";

export const OPENCLAW_RUNTIME_MODE_SLUG = "openclaw.async_rest";

export class OpenClawAdapter extends DeferredHttpWrapperAdapter {
  constructor(options: DeferredHttpWrapperAdapterOptions = {}) {
    super({
      adapterId: "openclaw",
      providerId: "provider_openclaw",
      runtimeId: "runtime_openclaw",
      runtimeModeId: "runtime_mode_openclaw_async_rest",
      runtimeModeSlug: OPENCLAW_RUNTIME_MODE_SLUG,
      name: "OpenClaw async REST",
      docsPath: "docs/development/adapters/OPENCLAW.md",
      configPrefix: "SWITCHYARD_OPENCLAW",
      unavailableReasonCode: "openclaw_config_missing",
      invalidConfigReasonCode: "openclaw_config_invalid",
      healthUnavailableReasonCode: "openclaw_health_unavailable",
      healthInvalidReasonCode: "openclaw_health_invalid",
      healthTooLargeReasonCode: "openclaw_health_too_large",
      bridgeUnverifiedReasonCode: "openclaw_api_boundary_unverified",
      startBlockedReasonCode: "openclaw_adapter_unverified"
    }, options);
  }
}
