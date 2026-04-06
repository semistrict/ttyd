// ttyd binary protocol constants
// Messages are: [command_byte][payload...]

// Sent by ttyd client (terminal provider) to server
export const OUTPUT = 0x30; // '0' - terminal output data
export const SET_WINDOW_TITLE = 0x31; // '1' - window title
export const SET_PREFERENCES = 0x32; // '2' - client preferences JSON

// Sent by viewer (browser) to server, relayed to ttyd client
export const INPUT = 0x30; // '0' - keyboard input
export const RESIZE_TERMINAL = 0x31; // '1' - resize {columns, rows}
export const PAUSE = 0x32; // '2' - flow control pause
export const RESUME = 0x33; // '3' - flow control resume

// Viewer multiplexing protocol (JSON over WebSocket text frames)
// Browser <-> DO uses JSON messages with a "tab" field for multiplexing.
// DO <-> ttyd uses raw ttyd binary protocol (one WS per tab).

export interface ViewerMessage {
  type: "input" | "resize" | "pause" | "resume" | "new_tab";
  tab: string;
  data?: string; // base64 payload for encrypted ttyd client frames
  cols?: number;
  rows?: number;
}

export interface ServerMessage {
  type: "output" | "title" | "prefs" | "tab_added" | "tab_removed" | "tab_list";
  tab: string;
  data?: string; // base64 payload for ttyd frames
  tabs?: string[];
}
