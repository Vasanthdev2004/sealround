"use client";

import { motion } from "motion/react";

/** Each page enters with a short fade and rise. Reduced motion: the fade only (MotionProvider). */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="w-full"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.23, 1, 0.32, 1] }}
    >
      {children}
    </motion.div>
  );
}
