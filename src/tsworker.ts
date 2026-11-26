// Web worker for the TypeScript service (src/tsservice.ts). It is separate from the Langium worker:
// the compiler is large and slow to start, and must never delay the analysis of a program.
// Every request carries the current texts, so the service cannot drift from what is on screen.
import { createService, type CodeFile, type Sources } from './tsservice';

export interface TsRequest {
    id: number;
    type: 'init' | 'diagnostics' | 'complete' | 'hover' | 'definition' | 'rename';
    libs?: Record<string, string>;     // for init: the type declarations
    sources?: Sources;
    file?: CodeFile;
    offset?: number;
}

let service: ReturnType<typeof createService> | undefined;

self.onmessage = (event: MessageEvent<TsRequest>) => {
    const { id, type, libs, sources, file = 'validator', offset = 0 } = event.data;
    const started = performance.now();
    try {
        let result: unknown = true;
        if (type === 'init') service = createService(libs ?? {});
        else {
            if (!service) throw new Error('The TypeScript service is not started.');
            if (sources) service.update(sources);
            result = type === 'diagnostics' ? { validator: service.diagnostics('validator'), generator: service.diagnostics('generator') }
                : type === 'complete' ? service.complete(file, offset)
                : type === 'hover' ? service.hover(file, offset)
                : type === 'definition' ? service.definition(file, offset)
                : service.rename(file, offset);
        }
        self.postMessage({ id, ok: true, result, ms: performance.now() - started });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
