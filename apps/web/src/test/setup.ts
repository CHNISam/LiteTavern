import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { setActiveLocale } from '../lib/i18n';

// jsdom reports an English navigator, which would otherwise make every test read
// the English dictionary. Assertions are written against the source locale, so it
// is pinned here; a test that cares about English switches locale explicitly.
setActiveLocale('zh-CN');
