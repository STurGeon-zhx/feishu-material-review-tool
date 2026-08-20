import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "飞书客户素材审核 POC",
  description: "真实验证飞书 Base 客户素材审核链路",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
