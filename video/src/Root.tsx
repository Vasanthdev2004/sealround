import React from "react";
import { Composition } from "remotion";
import { Launch, LAUNCH_FRAMES } from "./Launch";
import { FPS } from "./lib/theme";

export function Root() {
  return <Composition id="Launch" component={Launch} durationInFrames={LAUNCH_FRAMES} fps={FPS} width={1920} height={1080} />;
}
