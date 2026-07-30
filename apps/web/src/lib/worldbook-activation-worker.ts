/// <reference lib="webworker" />

import {
  activateWorldbookEntries,
  type WorldbookLimits
} from './worldbook-activation';
import type { WorldbookEntryAsset } from './lore-store';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (
  event: MessageEvent<{
    entries: WorldbookEntryAsset[];
    input: string | { content_text: string }[];
    limits: WorldbookLimits;
  }>
) => {
  self.postMessage(
    activateWorldbookEntries(
      event.data.entries,
      event.data.input,
      event.data.limits
    )
  );
};

export {};
