function viewModel() {
  this.firstName = "John";
  this.lastName = "Naylor";
  this.fullName = this.firstName + " " + this.lastName;

  this.phone = "";
  this.email = "jonaylor89@gmail.com";
  this.github = "https://github.com/jonaylor89";
  this.website = "https://jonaylor.com";

  this.sections = [
    {
      header: ["Skills"],
      subsections: [
        {
          list: [
            "NodeJS",
            "HTML/CSS",
            "Angular",
            "Vue",
            "Flutter",
            "SQL",
            "Bash",
            "Ansible",
            "Java",
            "Kafka",
            "Spark",
            "Hadoop",
            ".NET",
            "Python",
            "Android",
            "iOS",
            "Swift",
            "SwiftUI",
            "C/C++",
            "Rust",
            "Go",
            "Docker",
            "Kubernetes",
            "GCP",
            "AWS",
            "Terraform",
            "Ethereum",
            "Solidity",
            "Solana",
            "AI/ML/DS",
            "web crawling",
            "data engineering",
          ],
        },
      ],
    },
    {
      header: ["Employment"],
      subsections: [
        {
          header: [
            "New York City, NY",
            "Tapped Ai",
            "Spring 2023 - Present",
          ],
          bullets: [
            "CEO / Technical Founder",
            "create a world tour from your iPhone",
            "live music data analytics",
            [
              "Flutter, Python, Nodejs, GCP, Firebase+NoSQL, AI/ML/DS, Clickhouse, React, Realtime-Steaming, Web Crawling",
            ],
          ],
        },
        {
          header: ["New York City, NY", "Udio", "Fall 2024 - Present"],
          bullets: [
            "Product Engineer (Contract)",
            "Developed on and manage machine learning pipelines on GCP",
            "Build A/B testing into webapp",
            "Used product-analytics to guide feature development",
            ["Nextjs, Supabase, Golang, k8s, GCP, LLMs, Mixpanel"],
          ],
        },
        {
          header: ["San Fransisco, CA", "Audius", "Spring 2022 - Spring 2023"],
          bullets: [
            "Software Engineer",
            "Developed on and manage GCP + AWS infrastructure",
            "Built atop a decentralized and distributed network",
            "Added distributed tracing with open-telemetry",
            "Developed on in-house content storage system",
            ["Nodejs, Python, Rust, AWS, GCP, solana, ethereum"],
          ],
        },
        {
          header: ["Richmond, VA", "Capital One", "Summer 2019 - Spring 2022"],
          bullets: [
            "Associate Software Engineer",
            "Develop on and manage AWS infrastructure for real time payments",
            "Created data pipelines for new DS/ML workloads",
            "Modernization work for Architecture, APIs, and design processes",
            [
              "Snowflake, MQTT, Kafka, Angular, Nodejs, Java Spring Boot, Postgres, Jenkins, AWS",
            ],
          ],
        },
        {
          header: [
            "Richmond, VA",
            "Afton Chemical",
            "Winter 2018 - Summer 2019",
          ],
          bullets: [
            "Software Development",
            "Worked on C# and Angular web apps for data scientists and chemical engineers",
            ["C#, Angular, Office 365"],
          ],
        },
        {
          noPrint: true,
          header: [
            "Richmond, VA",
            "VCU Labs & Classrooms Computing",
            "Summer 2018 - Summer 2019",
          ],
          bullets: [
            "Technician for campus computers",
            "Developed python projects and bash scripts for VCU's support technicians",
            [
              "Embedded system and web server for the campus laptop kiosks",
              "Desktop application to generate reports for classroom scheduling ",
            ],
          ],
        },
        {
          noPrint: true,
          header: [
            "Richmond, VA",
            "Research Assistant",
            "Fall 2018 - Spring 2019",
          ],
          bullets: [
            "Maintain Intellij plugin StackInTheFlow",
            [
              "Brings stack-overflow into the Intellij IDEA",
              "Uses machine learning to assist in auto generating queries",
            ],
            "Mining Software Repository (MSR) Challenge",
            ["~Discover trends in a dataset from stack-overflow"],
          ],
        },
      ],
    },
    {
      header: ["Prominent Projects"],
      subsections: [
        {
          decorators: {
            icon: "github",
            url: "https://github.com/jonaylor89/WineInAMillion",
          },
          header: ["Wine in a Million", "Fall 2019"],
          bullets: [
            "Won <a href='https://devpost.com/software/wine-in-a-million'>first place</a> for GDIT's Natural Language Processing Challenge",
            "Uses BERT as a Service (AI/ML/NLP Model), Jupyter notebooks, and a wine review dataset to recommend wine to users similar to their current tastes",
          ],
        },
        {
          decorators: {
            icon: "github",
            url: "https://github.com/BatmaniNRobin/HotWheeels_Ramhacks2019",
          },
          header: ["Hot Wheels", "Fall 2019"],
          bullets: [
            "Won <a href='https://devpost.com/software/hot-wheels'>second place</a> at RamHacks 2019",
            "Uses Augmented Reality, AI, and microservices (Flask Framework) to let CarMax customers check if a car in the lot is available or not",
          ],
        },
        {
          noPrint: true,
          decorators: {
            icon: "github",
            url: "https://github.com/jonaylor89/ZeroPWNd",
          },
          header: ["ZeroPWNd", "Fall 2018"],
          bullets: [
            "Won <a href='https://devpost.com/software/zeropwnd'>first place</a> for Willow Tree's challenge at RamHacks 2018",
            "Uses open source API and public data to check if a URL is a phishing link (Cyber Security)",
          ],
        },
        {
          noPrint: true,
          decorators: {
            icon: "github",
            url: "https://github.com/hudginspj/myo-mesh-tracking",
          },
          header: ["Myo Secure Tracking", "Spring 2018"],
          bullets: [
            "Won <a href='https://devpost.com/software/myo-secure-tracking'>best networking app</a> at HackVT 2018",
            "Uses bluetooth communication and the Myo armband technology for securely monitoring visitors",
          ],
        },
        {
          decorators: {
            icon: "github",
            url: "https://github.com/jonaylor89/MonkeyInterpreter",
          },
          header: ["MonkeyLang Interpreter", "Winter 2017"],
          bullets: [
            "Programming Language Interpreter written in Golang",
            [
              "Implements a bytecode compiler and virtual machine",
              "Includes first class functions and closures",
              "Unit tests written using Golang's testing library",
            ],
          ],
        },
        {
          decorators: {
            icon: "github",
          },
          header: ["Ditto", "Spring 2019"],
          bullets: [
            "Submission to Moog's annual hackathon at Georgia Tech",
            [
              "Latin American drum inspired instrument with the ability to record and playback drum beats",
              "Used Arduino Mega and Moog Werkstatt to record, store, and playback sounds",
            ],
          ],
        },
        {
          header: ["Collegiate Cyber Defense Competition", "Spring 2019"],
          bullets: [
            "Placed 2nd at the Mid-Atlantic's Collegiate Cyber Defense Competition",
            [
              "Cyber defense competition used as a simulation for actual cyber defense in a business setting",
            ],
          ],
        },
        {
          header: ["Collegiate Penetration Testing Competition", "Fall 2019"],
          bullets: [
            "Placed 3rd at the the Northeasten Regional Collegiate Penetration Testing Competition",
            [
              "Offensive security competition used as a simulation for an actual corporate penetration test",
            ],
          ],
        },
      ],
    },
    {
      header: ["Leadership"],
      subsections: [
        {
          header: ["Lead Organizer of RVA Remix Competition", "Summer 2022"],
          bullets: [
            "https://rvaremix.org",
            "Lead a week long in-person music remixing competition",
            "Featured ~$1000 in prizes for winners",
            "Included workshops and seminars for participants",
          ],
        },
        {
          header: ["President of RamDev", "Summer 2018 - Summer 2020"],
          bullets: [
            "Organize weekly tech-talks by companies and students",
            "Invite corporate developers to speak and bring internships for students",
            "Organize Hackathon trips",
          ],
        },
        {
          header: ["Lead RamHacks Organizer", "Spring 2020 - Fall 2020"],
          bullets: [
            "Annual VCU Hackathon and largest hackathon in Virginia",
            "Oversaw VCU's first all virtual hackathon during COVID-19 lockdown",
          ],
        },
        {
          header: [
            "President of Student Advisory Board",
            "Summer 2020 - Present",
          ],
          bullets: [
            "~Help the department choose new faculty members",
            "~Help out with events, such as local hack day, for prospective and current computer science students",
          ],
        },
        {
          header: ["Vice President of ACM Club", "Summer 2018 - Fall 2019"],
          bullets: [
            "Organize weekly meetings to prepare for the ACM International Collegiate Programming Contest",
          ],
        },
        {
          header: ["Google Student Developer Lead", "Fall 2020 - Spring 2021"],
          bullets: [
            "Manage a student developer club including monthly workshops on Google Cloud",
          ],
        },
        {
          header: ["Hyperloop Software Lead", "Fall 2017 - Fall 2018"],
          bullets: [
            "Design and implement software for the Hyperloop team at VCU competing in SpaceX's annual competition",
            "Handpicked by SpaceX as one of the top 20 teams internationally",
          ],
        },
      ],
    },
    {
      header: ["Certifications"],
      subsections: [
        {
          decorators: {
            url: "https://www.credly.com/badges/0be60fbb-d187-4ab0-97f0-0076c78ddaf5",
          },
          header: [
            "AWS Certified Machine Learning - Specialty",
            "November 2021 - November 2024",
          ],
        },
        {
          decorators: {
            url: "https://www.youracclaim.com/badges/a4587f99-1dd4-4481-b9d5-cf2c68d5cb59/public_url",
          },
          header: [
            "AWS Solutions Architect - Associate",
            "July 2020 - July 2023",
          ],
        },
        {
          decorators: {
            url: "https://www.credential.net/b59fb0f6-fd21-409a-afc6-843ca8495924",
          },
          header: ["Google Associate Cloud Engineer", "July 2020 - July 2022"],
        },
      ],
    },
    {
      header: ["Education"],
      subsections: [
        {
          header: [
            "Richmond, VA",
            "Master of Science",
            "Fall 2020 - Spring 2021",
          ],
          bullets: [
            "Master of Computer Science degree from Virginia Commonwealth University (Data Science+Machine Learning)",
          ],
        },
        {
          header: [
            "Richmond, VA",
            "Bachelor of Science",
            "Fall 2017 - Spring 2020",
          ],
          bullets: [
            "Bachelor in Computer Science degree from Virginia Commonwealth University",
          ],
        },
      ],
    },
  ];
}
