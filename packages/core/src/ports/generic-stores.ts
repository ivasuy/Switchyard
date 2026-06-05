export interface GenericStore<T> {
  create(value: T): Promise<T>;
  get(id: string): Promise<T | undefined>;
  update(value: T): Promise<T>;
}

export interface ListCursor {
  createdAt: string;
  id: string;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: ListCursor | null;
}
