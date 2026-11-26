// Web worker: Langium runs here, and so does the validator and generator code of the user, so that
// a slow or looping analysis never freezes the page (the page ends this worker and starts a new
// one when an answer takes too long).
import * as langium from './analysis';

export interface Request {
    id: number;
    type: 'grammar' | 'program' | 'complete' | 'definition' | 'occurrences' | 'hover' | 'renameTarget' | 'rename' | 'format';
    target?: langium.Target;   // for the editor features: which editor asks
    text: string;
    offset?: number;
    name?: string;             // for rename: the new name; for program: the name of the program
    validator?: string;        // for grammar: the TypeScript written next to it
    generator?: string;
}

function answer({ type, target = 'program', text, offset = 0, name = '', validator, generator }: Request): Promise<unknown> {
    switch (type) {
        case 'grammar': return langium.analyzeGrammar(text, { validator, generator });
        case 'program': return langium.analyzeProgram(text, name || 'program');
        case 'complete': return langium.complete(target, text, offset);
        case 'definition': return langium.definition(target, text, offset);
        case 'occurrences': return langium.occurrences(target, text, offset);
        case 'hover': return langium.hover(target, text, offset);
        case 'renameTarget': return langium.renameTarget(target, text, offset);
        case 'rename': return langium.rename(target, text, offset, name);
        case 'format': return langium.format(target, text);
    }
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<Request>) => {
    const request = event.data;
    queue = queue.then(async () => {
        const started = performance.now();
        try {
            const result = await answer(request);
            self.postMessage({ id: request.id, ok: true, result, ms: performance.now() - started });
        } catch (error) {
            self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
};
