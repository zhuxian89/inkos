"use client";

import { AppstoreOutlined, ConsoleSqlOutlined, FundProjectionScreenOutlined, HomeOutlined, SettingOutlined } from "@ant-design/icons";
import { Layout, Menu } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS: MenuProps["items"] = [
  { key: "/", icon: <HomeOutlined />, label: <Link href="/">首页</Link> },
  { key: "/market", icon: <FundProjectionScreenOutlined />, label: <Link href="/market">市场趋势</Link> },
  { key: "/genres", icon: <AppstoreOutlined />, label: <Link href="/genres">题材库</Link> },
  { key: "/settings", icon: <SettingOutlined />, label: <Link href="/settings">设置</Link> },
  { key: "/commands", icon: <ConsoleSqlOutlined />, label: <Link href="/commands">高级工具</Link> },
];

function selectedKey(pathname: string): string {
  if (pathname.startsWith("/market")) return "/market";
  if (pathname.startsWith("/genres")) return "/genres";
  if (pathname.startsWith("/settings") || pathname.startsWith("/setup")) return "/settings";
  if (pathname.startsWith("/commands")) return "/commands";
  return "/";
}

export function AppFrame({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", background: "#0f172a", paddingInline: 20 }}>
        <div style={{ color: "#f8fafc", fontWeight: 700, marginRight: 20 }}>InkOS 网页端</div>
        <Menu
          mode="horizontal"
          selectedKeys={[selectedKey(pathname)]}
          items={NAV_ITEMS}
          style={{ flex: 1, minWidth: 0, background: "transparent", borderBottom: "none" }}
          theme="dark"
        />
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <div style={{ maxWidth: 1300, margin: "0 auto" }}>{children}</div>
      </Layout.Content>
    </Layout>
  );
}
