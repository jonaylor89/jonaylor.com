"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import SunIcon from "@/components/Icons/SunIcon";
import MoonIcon from "@/components/Icons/MoonIcon";
import logo from "@/components/assets/logo.png";

export default function Header() {
  const [theme, setTheme] = useState<string>("dark");
  useEffect(() => {
    const savedTheme = document.body.getAttribute("data-theme") ?? "dark";
    setTheme(savedTheme);
  }, []);
  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
  }, [theme]);
  const handleSwitchTheme = () => {
    setTheme(isDark ? "light" : "dark");
  };
  const isDark = theme === "dark";
  return (
    <div className="Header container">
      <div className="ten columns Header__inner">
        <Image src={logo} alt="logo" />
        &nbsp;&nbsp;&nbsp;
        <h2 className="text-[140%] font-medium mb-2.5 tracking-wide inline">
          <b>Johannes</b>
        </h2>
      </div>
      <button className="switch-theme-button" onClick={handleSwitchTheme}>
        {isDark ? <SunIcon color="white" /> : <MoonIcon />}
      </button>
    </div>
  );
}
