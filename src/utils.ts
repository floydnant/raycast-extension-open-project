export type ValueOf<T extends object> = T[keyof T];

export type EntryOf<T extends object> = {
  [K in keyof T]: [K, T[K]];
}[keyof T];

export type Mapped<T> = {
  [K in keyof T]: T[K];
};

export type MaskOf<T> = {
  [K in keyof T]: true;
};
export type PartialMaskOf<T> = Partial<MaskOf<T>>;

export const keysOf = <TObj extends Record<string, unknown>>(obj: TObj): (keyof TObj)[] => {
  return Object.keys(obj);
};
export const valuesOf = <TObj extends Record<string, unknown>>(obj: TObj): ValueOf<TObj>[] => {
  return Object.values(obj) as ValueOf<TObj>[];
};
export const entriesOf = <TObj extends Record<string, unknown>>(obj: TObj): EntryOf<TObj>[] => {
  return Object.entries(obj) as EntryOf<TObj>[];
};
