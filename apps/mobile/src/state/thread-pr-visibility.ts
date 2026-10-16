import { createContext } from "react";

/** Retained navigation screens keep cached PR badges without keeping queries alive. */
export const ThreadPrVisibilityContext = createContext(true);
