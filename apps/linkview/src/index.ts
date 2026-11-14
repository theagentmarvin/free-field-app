// @free-field/linkview — Linkview module barrel.
//
// Public surface:
//   - <LinkviewApp>  → route entry for `/linkview`. Hosts the
//                      LinkviewSplitCanvas plus the wave-55 chrome
//                      (tools toolbar <LinkviewNavToolbar> + panel
//                      slot <LinkviewNavPanel>), owns the
//                      active-building (shared store) / pdf /
//                      storey / mode state, and portals the shared
//                      3D surface into its right pane.

export { default as LinkviewApp } from "./LinkviewApp";
export type { LinkviewAppProps } from "./LinkviewApp";
export type { LinkviewMode } from "./linkviewMode";
export { loadLinkviewMode, persistLinkviewMode } from "./linkviewMode";