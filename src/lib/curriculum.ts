// CodeMind Academy — Official Curriculum Seed Data
// Programming & AI for 2nd year Egyptian Baccalaureate

export type CurriculumPart = {
  title: string;
  titleAr: string;
  description: string;
  units: CurriculumUnit[];
};

export type CurriculumUnit = {
  title: string;
  titleAr: string;
  icon: string;
  topics: CurriculumTopic[];
};

export type CurriculumTopic = {
  title: string;
  titleAr: string;
  lessons: CurriculumLesson[];
};

export type CurriculumLesson = {
  title: string;
  titleAr: string;
  duration: number;
  description?: string;
};

export const CURRICULUM: CurriculumPart[] = [
  {
    title: "Part One",
    titleAr: "الجزء الأول",
    description: "الأساسيات والمفاهيم المتعلقة بالـInformation Technology والـCybersecurity والـWeb Applications.",
    units: [
      {
        title: "Information Technology and Society",
        titleAr: "تكنولوجيا المعلومات والمجتمع",
        icon: "Globe",
        topics: [
          {
            title: "Intro to IT",
            titleAr: "مقدمة عن تكنولوجيا المعلومات",
            lessons: [
              { title: "What is IT?", titleAr: "إيه هي الـIT؟", duration: 90, description: "Overview of Information Technology and its impact on society." },
              { title: "Digital Citizenship", titleAr: "المواطنة الرقمية", duration: 90, description: "Responsibilities of being a digital citizen." },
            ],
          },
          {
            title: "Society & Technology",
            titleAr: "المجتمع والتكنولوجيا",
            lessons: [
              { title: "Tech Impact on Society", titleAr: "تأثير التكنولوجيا على المجتمع", duration: 90 },
              { title: "Ethics in IT", titleAr: "أخلاقيات الـIT", duration: 90 },
            ],
          },
        ],
      },
      {
        title: "Cybersecurity",
        titleAr: "الأمن السيبراني",
        icon: "ShieldCheck",
        topics: [
          {
            title: "Security Fundamentals",
            titleAr: "أساسيات الأمن",
            lessons: [
              { title: "Threats & Attacks", titleAr: "التهديدات والهجمات", duration: 90 },
              { title: "Defense Mechanisms", titleAr: "آليات الدفاع", duration: 90 },
            ],
          },
          {
            title: "Safe Online Behavior",
            titleAr: "السلوك الآمن أونلاين",
            lessons: [
              { title: "Passwords & Authentication", titleAr: "كلمات السر والمصادقة", duration: 90 },
              { title: "Phishing & Social Engineering", titleAr: "الـPhishing والـSocial Engineering", duration: 90 },
            ],
          },
        ],
      },
      {
        title: "Web Applications",
        titleAr: "تطبيقات الويب",
        icon: "Globe2",
        topics: [
          {
            title: "How the Web Works",
            titleAr: "إزاي الويب شغال",
            lessons: [
              { title: "Client-Server Model", titleAr: "نموذج Client-Server", duration: 90 },
              { title: "HTTP & HTTPS", titleAr: "بروتوكولات HTTP و HTTPS", duration: 90 },
            ],
          },
          {
            title: "Building Web Apps",
            titleAr: "بناء الـWeb Apps",
            lessons: [
              { title: "Frontend Basics", titleAr: "أساسيات الـFrontend", duration: 90 },
              { title: "Backend Basics", titleAr: "أساسيات الـBackend", duration: 90 },
            ],
          },
        ],
      },
      {
        title: "Web and Media Design",
        titleAr: "تصميم الويب والوسائط",
        icon: "Palette",
        topics: [
          {
            title: "Design Principles",
            titleAr: "مبادئ التصميم",
            lessons: [
              { title: "UI vs UX", titleAr: "الفرق بين UI و UX", duration: 90 },
              { title: "Color & Typography", titleAr: "الألوان والـTypography", duration: 90 },
            ],
          },
          {
            title: "Media Production",
            titleAr: "إنتاج الوسائط",
            lessons: [
              { title: "Images & Formats", titleAr: "الصور والـFormats", duration: 90 },
              { title: "Video for Web", titleAr: "الفيديو للويب", duration: 90 },
            ],
          },
        ],
      },
    ],
  },
  {
    title: "Part Two",
    titleAr: "الجزء الثاني",
    description: "الـData Science والـMachine Learning والـArtificial Intelligence.",
    units: [
      {
        title: "Data Collection and Cleaning",
        titleAr: "جمع وتنظيف البيانات",
        icon: "Database",
        topics: [
          {
            title: "Methods of Data Collection",
            titleAr: "طرق جمع البيانات",
            lessons: [
              { title: "Sources of Data", titleAr: "مصادر البيانات", duration: 90 },
              { title: "Web Scraping Basics", titleAr: "أساسيات الـWeb Scraping", duration: 90 },
            ],
          },
          {
            title: "Data Cleaning and Transformation",
            titleAr: "تنظيف وتحويل البيانات",
            lessons: [
              { title: "Handling Missing Data", titleAr: "التعامل مع البيانات الناقصة", duration: 90 },
              { title: "Data Transformation", titleAr: "تحويل البيانات", duration: 90 },
            ],
          },
          {
            title: "Open Data and APIs",
            titleAr: "البيانات المفتوحة والـAPIs",
            lessons: [
              { title: "Open Data Sources", titleAr: "مصادر الـOpen Data", duration: 90 },
              { title: "Working with APIs", titleAr: "التعامل مع الـAPIs", duration: 90 },
            ],
          },
        ],
      },
      {
        title: "Analysis and Communication",
        titleAr: "التحليل والتواصل",
        icon: "BarChart3",
        topics: [
          {
            title: "Statistical Inference",
            titleAr: "الاستدلال الإحصائي",
            lessons: [
              { title: "Descriptive Statistics", titleAr: "الإحصاء الوصفي", duration: 90 },
              { title: "Inferential Statistics", titleAr: "الإحصاء الاستدلالي", duration: 90 },
            ],
          },
          {
            title: "Regression Analysis",
            titleAr: "تحليل الانحدار",
            lessons: [
              { title: "Linear Regression", titleAr: "الانحدار الخطي", duration: 90 },
              { title: "Evaluating Models", titleAr: "تقييم الـModels", duration: 90 },
            ],
          },
          {
            title: "Data Visualization",
            titleAr: "تصور البيانات",
            lessons: [
              { title: "Chart Types", titleAr: "أنواع الـCharts", duration: 90 },
              { title: "Effective Communication", titleAr: "التواصل الفعّال", duration: 90 },
            ],
          },
        ],
      },
      {
        title: "Machine Learning and AI",
        titleAr: "تعلم الآلة والذكاء الاصطناعي",
        icon: "BrainCircuit",
        topics: [
          {
            title: "Basics of Machine Learning",
            titleAr: "أساسيات الـMachine Learning",
            lessons: [
              { title: "What is ML?", titleAr: "إيه هو الـML؟", duration: 90 },
              { title: "Supervised vs Unsupervised", titleAr: "الـSupervised والـUnsupervised", duration: 90 },
              { title: "Training & Testing", titleAr: "التدريب والاختبار", duration: 90 },
            ],
          },
          {
            title: "Neural Networks and Deep Learning",
            titleAr: "الشبكات العصبية والـDeep Learning",
            lessons: [
              { title: "Neural Networks Intro", titleAr: "مقدمة الـNeural Networks", duration: 90 },
              { title: "Deep Learning Concepts", titleAr: "مفاهيم الـDeep Learning", duration: 90 },
            ],
          },
          {
            title: "LLMs and Generative AI",
            titleAr: "الـLLMs والـGenerative AI",
            lessons: [
              { title: "What are LLMs?", titleAr: "إيه هم الـLLMs؟", duration: 90 },
              { title: "Generative AI Use Cases", titleAr: "تطبيقات الـGenerative AI", duration: 90 },
              { title: "Prompt Engineering", titleAr: "الـPrompt Engineering", duration: 90 },
            ],
          },
        ],
      },
    ],
  },
];
