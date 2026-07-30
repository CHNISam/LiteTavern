/// <reference lib="webworker" />

import {
  applyRegexScripts,
  type RegexExecutionOptions,
  type RegexScript
} from './regex-engine';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (
  event: MessageEvent<{
    input: string;
    scripts: RegexScript[];
    options: RegexExecutionOptions;
  }>
) => {
  self.postMessage({
    text: applyRegexScripts(
      event.data.input,
      event.data.scripts,
      event.data.options
    )
  });
};

export {};
