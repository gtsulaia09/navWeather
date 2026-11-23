import '@testing-library/jest-dom/vitest';
import { setPeerOptions } from '../share/peerConfig';

// Phone-to-phone sharing never reaches public relays from tests (ADR-020); tests that need it set a local relay.
setPeerOptions({ relays: [] });
