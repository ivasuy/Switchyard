import { DeferredHttpWrapperAdapter } from "../wrapper-http/deferred-http-wrapper-adapter.js";
import type { DeferredHttpWrapperAdapterOptions } from "../wrapper-http/types.js";

export const PAPERCLIP_RUNTIME_MODE_SLUG = "paperclip.async_rest";

export class PaperclipAdapter extends DeferredHttpWrapperAdapter {
  constructor(options: DeferredHttpWrapperAdapterOptions = {}) {
    super({
      adapterId: "paperclip",
      providerId: "provider_paperclip",
      runtimeId: "runtime_paperclip",
      runtimeModeId: "runtime_mode_paperclip_async_rest",
      runtimeModeSlug: PAPERCLIP_RUNTIME_MODE_SLUG,
      name: "Paperclip async REST",
      docsPath: "docs/development/adapters/PAPERCLIP.md",
      configPrefix: "SWITCHYARD_PAPERCLIP",
      unavailableReasonCode: "paperclip_config_missing",
      invalidConfigReasonCode: "paperclip_config_invalid",
      healthUnavailableReasonCode: "paperclip_health_unavailable",
      healthInvalidReasonCode: "paperclip_health_invalid",
      healthTooLargeReasonCode: "paperclip_health_too_large",
      bridgeUnverifiedReasonCode: "paperclip_api_boundary_unverified",
      startBlockedReasonCode: "paperclip_adapter_unverified"
    }, options);
  }
}
