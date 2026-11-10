import { autoInit, createReporter, init } from "./index";

const script = document.currentScript as HTMLScriptElement | null;
autoInit(script);

export { createReporter, init };
