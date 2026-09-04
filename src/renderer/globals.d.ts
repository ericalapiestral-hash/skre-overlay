// 미리 열어 준 통로(src/preload/*.js)가 화면에 어떤 모양으로 보이는지.
// 이름을 잘못 쓰면 타입 검사에서 걸린다.

interface OverlayApi {
  tune: { cropHeight: number };
  catalog: {
    load(): Promise<any>;
    body(id: string): Promise<string>;
    pickFile(): Promise<any>;
    reveal(): Promise<boolean>;
    onUpdated(fn: () => void): () => void;
  };
  config: {
    get(): Promise<any>;
    set(patch: object): Promise<any>;
  };
  region: {
    open(): Promise<void>;
    onPicked(fn: (region: any) => void): () => void;
  };
  capture: {
    source(displayId: number): Promise<{ sourceId: string; width: number; height: number } | null>;
  };
  engine: {
    setFlow(buildId: string, picks: object, opts?: object): Promise<{ steps: any[]; index: number }>;
    setIndex(i: number): Promise<number>;
    reset(): Promise<boolean>;
    feed(gray: Uint8Array, w: number, h: number): Promise<any>;
    teach(gray: Uint8Array, w: number, h: number, value: string): Promise<any>;
    forget(): Promise<boolean>;
  };
  win: {
    collapse(on: boolean): void;
    clickThrough(on: boolean): void;
    quit(): void;
    onClickThrough(fn: (on: boolean) => void): () => void;
  };
  keys: {
    onNav(fn: (delta: number) => void): () => void;
    onAutoToggle(fn: () => void): () => void;
    onFailed(fn: (combos: string[]) => void): () => void;
  };
}

interface PickerApi {
  onInit(fn: (data: { displayId: number }) => void): void;
  done(region: object): void;
  cancel(): void;
}

interface Window {
  overlay: OverlayApi;
  picker: PickerApi;
}
