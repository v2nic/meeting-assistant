import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Meeting Assistant",
  description: "Transcribe meetings, track agenda timing, and classify topics.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
