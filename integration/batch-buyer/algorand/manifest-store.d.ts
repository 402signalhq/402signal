export interface AlgorandManifestJournal {
    get(key: string): any | undefined;
    once(key: string, value: unknown): boolean;
}
export declare class AlgorandManifestStore implements AlgorandManifestJournal {
    private db;
    constructor(path: string);
    get(key: string): any;
    once(key: string, value: unknown): boolean;
    close(): void;
}
