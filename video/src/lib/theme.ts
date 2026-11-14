import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const inter = loadInter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

// Three colours on one canvas: white for statements, grey for context,
// Sealround blue for the single thing to look at.
export const T = {
  bg: "#050506",
  ink: "#F5F5F7",
  dim: "#8A8A90",
  faint: "rgba(245,245,247,0.12)",
  hair: "rgba(245,245,247,0.10)",
  blue: "#3D7EFF",
  blueFill: "#0052FF",
  sans: inter.fontFamily,
  mono: mono.fontFamily,
};

export const FPS = 30;
export const BAR = 60;
export const BEAT = 15;
