export type PluginViewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PluginViewModalGeometry = {
  /** The renderer-measured work-panel rectangle. */
  dock: PluginViewRect;
  /** The host-owned, inset application-window rectangle. */
  modal: PluginViewRect;
};

export type PluginViewModalRequest = {
  pluginId: string;
  senderId: number;
};
