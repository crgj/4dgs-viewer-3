export interface GaussianImportRequest {
  file: File;
  signal?: AbortSignal;
}

export interface GaussianExportRequest<TDocument = unknown> {
  document: TDocument;
  signal?: AbortSignal;
}

export interface GaussianFormatAdapter<TDocument = unknown> {
  id: string;
  displayName: string;
  extensions: readonly string[];
  canImport(header: Uint8Array, fileName: string): boolean | Promise<boolean>;
  import(request: GaussianImportRequest): Promise<TDocument>;
  export?(request: GaussianExportRequest<TDocument>): Promise<Blob>;
}
