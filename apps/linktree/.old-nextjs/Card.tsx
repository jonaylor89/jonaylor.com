"use client";

import type { Item } from "@/components/assets/items";
import { motion } from "framer-motion";
import Image from "next/image";

export default function Card(props: Item & { i: number }) {
  const variants = {
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: {
        delay: i * 0.1,
        duration: 0.5,
        ease: "easeIn",
        type: "spring",
        stiffness: 50,
      },
    }),
    hidden: { opacity: 0, y: 200 },
  };

  return (
    <a href={props.link}>
      <motion.div
        className="Card four columns"
        initial="hidden"
        animate="visible"
        custom={props.i}
        variants={variants}
      >
        <Image
          className="cover"
          src={props.image}
          alt={`${props.title} cover`}
          style={{ objectFit: "cover" }}
        />
        <div className="mt-[5px]">
          <h2 className="text-[140%] font-medium mb-2.5 tracking-wide inline">
            {props.title}
          </h2>
          <p>{props.subtitle}</p>
        </div>
      </motion.div>
    </a>
  );
}
