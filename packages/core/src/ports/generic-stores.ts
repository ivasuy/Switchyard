export interface GenericStore<T> {
  create(value: T): Promise<T>;
  get(id: string): Promise<T | undefined>;
  update(value: T): Promise<T>;
}
