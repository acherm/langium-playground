// Web worker: Langium runs here, so that a slow or looping analysis never freezes the page
// (the page ends this worker and starts a new one when an answer takes too long).
import { analyzeGrammar, analyzeProgram, complete } from './analysis';

interface Request { id: number; type: 'grammar' | 'program' | 'complete'; text: string; offset?: number }

let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<Request>) => {
    const { id, type, text, offset } = event.data;
    queue = queue.then(async () => {
        const started = performance.now();
        try {
            const result = type === 'grammar' ? await analyzeGrammar(text)
                : type === 'program' ? await analyzeProgram(text)
                : await complete(text, offset ?? 0);
            self.postMessage({ id, ok: true, result, ms: performance.now() - started });
        } catch (error) {
            self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
};
