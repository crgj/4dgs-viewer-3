import type { GaussianFormatAdapter } from './GaussianFormatAdapter';

export class GaussianFormatRegistry {
  private readonly adapters = new Map<string, GaussianFormatAdapter>();

  register(adapter: GaussianFormatAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Gaussian format adapter "${adapter.id}" is already registered.`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  unregister(id: string): void {
    this.adapters.delete(id);
  }

  get(id: string): GaussianFormatAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): GaussianFormatAdapter[] {
    return [...this.adapters.values()];
  }

  findByExtension(fileName: string): GaussianFormatAdapter[] {
    const extension = fileName.split('.').pop()?.toLowerCase();
    if (!extension) {
      return [];
    }
    return this.list().filter((adapter) => adapter.extensions.some((value) => value.toLowerCase() === extension));
  }
}
