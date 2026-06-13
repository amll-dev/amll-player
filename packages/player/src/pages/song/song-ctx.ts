import { createContext } from "react";
import type { Song } from "../../utils/db-client.ts";

export const SongContext = createContext<Song | undefined>(undefined);
