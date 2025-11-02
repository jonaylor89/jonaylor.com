import website from "../assets/website.png";
// import instagram from '../assets/instagram.png'
import appstore from "../assets/playstore.png";
// import youtube from '../assets/youtube.jpeg'
import linkedin from "../assets/linkedin.jpg";
import github from "../assets/github.png";
import telegram from "../assets/telegram.png";
import twitter from "../assets/twitter.png";
import blog from "../assets/blog.png";
import intheloop from "../assets/intheloop.png";
import tapped from "../assets/tapped.png";
import housefly from "../assets/housefly.png";
import moments from "../assets/moments-fm.jpg";
import saintjohn from "../assets/saintjohn.png";
import type { StaticImageData } from "next/image";

export type Item = {
  title: string;
  subtitle: string;
  image: StaticImageData;
  link: string;
};

export const items: Item[] = [
  {
    title: "Website",
    subtitle: "Look at my work!",
    image: website,
    link: "https://jonaylor.xyz", //your personal website or portfolio  link
  },
  {
    title: "Blog",
    subtitle: "The latest content for what I've written",
    image: blog,
    link: "https://blog.jonaylor.com", // Blog link
  },
  {
    title: "GitHub",
    subtitle: "@jonaylor89 | 🏠 of my open-source projects",
    image: github,
    link: "https://github.com/jonaylor89", //Github Profile link
  },
  {
    title: "Tapped Ai",
    subtitle: "the leading live music database",
    image: tapped,
    link: "https://tapped.ai",
  },
  {
    title: "In The Loop",
    subtitle: "The platform tailored for artists and producers to collaborate",
    image: intheloop,
    link: "https://intheloopstudio.com", // In The Loop landing page
  },
  {
    title: "Housefly",
    subtitle: "An interactive project designed to teach web scraping",
    image: housefly,
    link: "https://housefly.cc",
  },
  {
    title: "Moments",
    subtitle: "Transform life’s precious memories into beautiful, personalized melodies.",
    image: moments,
    link: "https://moments.fm",
  },
  {
    title: "Saint John",
    subtitle: "Your new distraction-free Android home screen",
    image: saintjohn,
    link: "https://saintjohn.jonaylor.com",
  },
  {
    title: "Apps",
    subtitle: "Hub of my awesome 🔥 Apps",
    image: appstore,
    link: "https://play.google.com/store/apps/developer?id=John+Naylor", // google play linik
  },
  {
    title: "Twitter",
    subtitle: "@jonaylor89 | Don't forget to follow me 😉",
    image: twitter,
    link: "https://twitter.com/jonaylor89", // twitter profile link
  },
  {
    title: "LinkedIn",
    subtitle: "Connect with me on LinkedIn",
    image: linkedin,
    link: "https://www.linkedin.com/in/john-naylor", // linkedin profile link
  },
  {
    title: "Telegram",
    subtitle: "@jonaylor89 | Let's chat!",
    image: telegram,
    link: "https://telegram.me/jonaylor89", // telegram profile link
  },
];

export default items;
