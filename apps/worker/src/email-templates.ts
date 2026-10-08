import { brandCopy } from "./fork/product-name";

// Localized transactional email copy for the app's 8 locales (mirrors
// apps/web/src/i18n). Recipient language is resolved from the requester's
// Accept-Language header: every send path (signup, resend verification,
// forgot password, email change) is self-service, so the requester is the
// recipient. Arabic renders the HTML body right-to-left.

export type EmailLocale =
  | "zh-CN"
  | "en-US"
  | "ja"
  | "fr"
  | "es"
  | "ko"
  | "ru"
  | "ar";

const SUPPORTED: EmailLocale[] = [
  "zh-CN",
  "en-US",
  "ja",
  "fr",
  "es",
  "ko",
  "ru",
  "ar",
];

const PREFIX_TO_LOCALE: Record<string, EmailLocale> = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja",
  fr: "fr",
  es: "es",
  ko: "ko",
  ru: "ru",
  ar: "ar",
};

/**
 * Best-match an Accept-Language header against the supported locales.
 * Handles q-values and case-insensitive tags; falls back to en-US.
 */
export function pickEmailLocale(
  acceptLanguage: string | null | undefined,
): EmailLocale {
  if (!acceptLanguage) return "en-US";
  const candidates = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const quality = qParam ? Number.parseFloat(qParam.slice(2)) || 0 : 1;
      return { tag: (tag ?? "").trim().toLowerCase(), quality };
    })
    .filter((c) => c.tag && c.quality > 0)
    .sort((a, b) => b.quality - a.quality);
  for (const { tag } of candidates) {
    const direct = SUPPORTED.find((l) => l.toLowerCase() === tag);
    if (direct) return direct;
    const prefix = PREFIX_TO_LOCALE[tag.split("-")[0] ?? ""];
    if (prefix) return prefix;
  }
  return "en-US";
}

type OneEmailCopy = {
  subject: string;
  heading: string;
  body: string;
  button: string;
  /** Footer note tied to this email's semantics (not-you disclaimer). */
  ignore: string;
};

export type EmailCopy = {
  /** "Or paste this link: {url}" */
  pasteLink: string;
  /** "This link expires in {hours} hours." */
  expiresHours: string;
  verifyEmail: OneEmailCopy;
  resetPassword: OneEmailCopy;
  changeEmail: OneEmailCopy;
};

const COPY: Record<EmailLocale, EmailCopy> = {
  "zh-CN": {
    pasteLink: "或复制粘贴此链接：{url}",
    expiresHours: "此链接将在 {hours} 小时后失效。",
    verifyEmail: {
      subject: "验证你的 FlareMo 邮箱",
      heading: "验证你的邮箱",
      body: "欢迎来到 FlareMo！确认此地址即可完成注册。",
      button: "验证邮箱",
      ignore: "如果你没有注册过，忽略这封邮件即可。",
    },
    resetPassword: {
      subject: "重置你的 FlareMo 密码",
      heading: "重置密码",
      body: "我们收到重置此地址 FlareMo 密码的请求。点击下方按钮设置新密码。",
      button: "重置密码",
      ignore: "如果你没有发起此请求，忽略这封邮件即可，密码保持不变。",
    },
    changeEmail: {
      subject: "确认你的新 FlareMo 邮箱",
      heading: "确认新邮箱",
      body: "有请求要将此地址设为你的 FlareMo 登录邮箱。确认后更改才会生效。",
      button: "确认新邮箱",
      ignore: "确认之前现有邮箱继续可用。如果这不是你的操作，请忽略此邮件。",
    },
  },
  "en-US": {
    pasteLink: "Or paste this link: {url}",
    expiresHours: "This link expires in {hours} hours.",
    verifyEmail: {
      subject: "Verify your FlareMo email",
      heading: "Verify your email",
      body: "Welcome to FlareMo! Confirm this address to finish creating your account.",
      button: "Verify email",
      ignore: "If you did not sign up, you can ignore this email.",
    },
    resetPassword: {
      subject: "Reset your FlareMo password",
      heading: "Reset your password",
      body: "We received a request to reset the FlareMo password for this address. Click below to choose a new one.",
      button: "Reset password",
      ignore:
        "If you did not request this, you can ignore this email and your password stays unchanged.",
    },
    changeEmail: {
      subject: "Confirm your new FlareMo email",
      heading: "Confirm your new email",
      body: "A request was made to use this address as your FlareMo login email. Confirm it to finish the change.",
      button: "Confirm new email",
      ignore:
        "Your current email keeps working until you confirm. If this was not you, ignore this email.",
    },
  },
  ja: {
    pasteLink: "またはこのリンクを貼り付けてください：{url}",
    expiresHours: "このリンクは {hours} 時間後に失効します。",
    verifyEmail: {
      subject: "FlareMo のメールアドレスを確認してください",
      heading: "メールアドレスの確認",
      body: "FlareMo へようこそ！このアドレスを確認するとアカウント作成が完了します。",
      button: "メールアドレスを確認",
      ignore: "登録に心当たりがない場合は、このメールは無視してください。",
    },
    resetPassword: {
      subject: "FlareMo のパスワードをリセットしてください",
      heading: "パスワードのリセット",
      body: "このアドレスの FlareMo パスワード再設定のリクエストを受け付けました。下のボタンから新しいパスワードを設定してください。",
      button: "パスワードをリセット",
      ignore:
        "リクエストに心当たりがない場合は、このメールを無視すればパスワードは変更されません。",
    },
    changeEmail: {
      subject: "新しい FlareMo メールアドレスを確認してください",
      heading: "新しいメールアドレスの確認",
      body: "このアドレスを FlareMo のログイン用メールアドレスにするリクエストがありました。確認すると変更が完了します。",
      button: "新しいメールを確認",
      ignore:
        "確認するまで現在のメールは引き続き使えます。心当たりがない場合はこのメールを無視してください。",
    },
  },
  fr: {
    pasteLink: "Ou collez ce lien : {url}",
    expiresHours: "Ce lien expire dans {hours} heures.",
    verifyEmail: {
      subject: "Vérifiez votre e-mail FlareMo",
      heading: "Vérifiez votre e-mail",
      body: "Bienvenue sur FlareMo ! Confirmez cette adresse pour terminer la création de votre compte.",
      button: "Vérifier l'e-mail",
      ignore:
        "Si vous ne vous êtes pas inscrit, vous pouvez ignorer cet e-mail.",
    },
    resetPassword: {
      subject: "Réinitialisez votre mot de passe FlareMo",
      heading: "Réinitialiser le mot de passe",
      body: "Nous avons reçu une demande de réinitialisation du mot de passe FlareMo pour cette adresse. Cliquez ci-dessous pour en choisir un nouveau.",
      button: "Réinitialiser le mot de passe",
      ignore:
        "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe restera inchangé.",
    },
    changeEmail: {
      subject: "Confirmez votre nouvel e-mail FlareMo",
      heading: "Confirmer le nouvel e-mail",
      body: "Une demande a été faite pour utiliser cette adresse comme e-mail de connexion FlareMo. Confirmez-la pour terminer le changement.",
      button: "Confirmer le nouvel e-mail",
      ignore:
        "Votre e-mail actuel reste valable jusqu'à la confirmation. Si ce n'était pas vous, ignorez cet e-mail.",
    },
  },
  es: {
    pasteLink: "O pega este enlace: {url}",
    expiresHours: "Este enlace expira en {hours} horas.",
    verifyEmail: {
      subject: "Verifica tu correo de FlareMo",
      heading: "Verifica tu correo",
      body: "¡Bienvenido a FlareMo! Confirma esta dirección para terminar de crear tu cuenta.",
      button: "Verificar correo",
      ignore: "Si no te registraste, puedes ignorar este correo.",
    },
    resetPassword: {
      subject: "Restablece tu contraseña de FlareMo",
      heading: "Restablecer la contraseña",
      body: "Recibimos una solicitud para restablecer la contraseña de FlareMo de esta dirección. Haz clic abajo para elegir una nueva.",
      button: "Restablecer contraseña",
      ignore:
        "Si no solicitaste esto, puedes ignorar este correo y tu contraseña seguirá igual.",
    },
    changeEmail: {
      subject: "Confirma tu nuevo correo de FlareMo",
      heading: "Confirma el correo nuevo",
      body: "Se hizo una solicitud para usar esta dirección como tu correo de acceso de FlareMo. Confírmala para terminar el cambio.",
      button: "Confirmar el correo nuevo",
      ignore:
        "Tu correo actual sigue funcionando hasta que confirmes. Si no fuiste tú, ignora este correo.",
    },
  },
  ko: {
    pasteLink: "또는 이 링크를 붙여넣어 주세요: {url}",
    expiresHours: "이 링크는 {hours}시간 후 만료됩니다.",
    verifyEmail: {
      subject: "FlareMo 이메일을 인증해 주세요",
      heading: "이메일 인증",
      body: "FlareMo에 오신 것을 환영합니다! 이 주소를 인증하면 가입이 완료됩니다.",
      button: "이메일 인증",
      ignore: "가입한 적이 없다면 이 메일은 무시해도 됩니다.",
    },
    resetPassword: {
      subject: "FlareMo 비밀번호를 재설정해 주세요",
      heading: "비밀번호 재설정",
      body: "이 주소의 FlareMo 비밀번호 재설정 요청을 받았습니다. 아래 버튼에서 새 비밀번호를 설정해 주세요.",
      button: "비밀번호 재설정",
      ignore:
        "요청하신 적이 없다면 이 메일을 무시하세요. 비밀번호는 그대로 유지됩니다.",
    },
    changeEmail: {
      subject: "새 FlareMo 이메일을 확인해 주세요",
      heading: "새 이메일 확인",
      body: "이 주소를 FlareMo 로그인 이메일로 사용해 달라는 요청이 있었습니다. 확인하면 변경이 완료됩니다.",
      button: "새 이메일 확인",
      ignore:
        "확인하기 전까지는 현재 이메일을 계속 사용할 수 있습니다. 본인이 하신 요청이 아니라면 이 메일을 무시하세요.",
    },
  },
  ru: {
    pasteLink: "Или вставьте эту ссылку: {url}",
    expiresHours: "Ссылка истечёт через {hours} ч.",
    verifyEmail: {
      subject: "Подтвердите эл. почту FlareMo",
      heading: "Подтверждение эл. почты",
      body: "Добро пожаловать во FlareMo! Подтвердите этот адрес, чтобы завершить создание аккаунта.",
      button: "Подтвердить почту",
      ignore: "Если вы не регистрировались, просто игнорируйте это письмо.",
    },
    resetPassword: {
      subject: "Сброс пароля FlareMo",
      heading: "Сброс пароля",
      body: "Мы получили запрос на сброс пароля FlareMo для этого адреса. Нажмите кнопку ниже, чтобы задать новый.",
      button: "Сбросить пароль",
      ignore:
        "Если вы не запрашивали сброс, игнорируйте письмо — пароль останется прежним.",
    },
    changeEmail: {
      subject: "Подтвердите новую эл. почту FlareMo",
      heading: "Подтверждение новой почты",
      body: "Поступил запрос использовать этот адрес как почту для входа во FlareMo. Подтвердите его, чтобы завершить смену.",
      button: "Подтвердить новую почту",
      ignore:
        "Текущая почта работает до подтверждения. Если это были не вы, игнорируйте письмо.",
    },
  },
  ar: {
    pasteLink: "أو الصق هذا الرابط: {url}",
    expiresHours: "ينتهي هذا الرابط بعد {hours} ساعة.",
    verifyEmail: {
      subject: "أكّد بريدك الإلكتروني في FlareMo",
      heading: "تأكيد البريد الإلكتروني",
      body: "مرحبًا بك في FlareMo! أكّد هذا العنوان لإتمام إنشاء حسابك.",
      button: "تأكيد البريد",
      ignore: "إن لم تكن قد سجّلت، يمكنك تجاهل هذه الرسالة.",
    },
    resetPassword: {
      subject: "أعد تعيين كلمة مرور FlareMo",
      heading: "إعادة تعيين كلمة المرور",
      body: "استلمنا طلبًا لإعادة تعيين كلمة مرور FlareMo لهذا العنوان. انقر أدناه لاختيار كلمة مرور جديدة.",
      button: "إعادة تعيين كلمة المرور",
      ignore: "إن لم تطلب ذلك، تجاهل هذه الرسالة وستبقى كلمة المرور كما هي.",
    },
    changeEmail: {
      subject: "أكّد بريدك الجديد في FlareMo",
      heading: "تأكيد البريد الجديد",
      body: "وصلنا طلبًا لاستخدام هذا العنوان كبريد الدخول إلى FlareMo. أكّده لإتمام التغيير.",
      button: "تأكيد البريد الجديد",
      ignore:
        "يبقى بريدك الحالي صالحًا حتى التأكيد. إن لم يكن هذا طلبك، تجاهل الرسالة.",
    },
  },
};

export function emailCopy(locale: EmailLocale): EmailCopy {
  return brandCopy(COPY[locale]);
}

export function interpolate(
  template: string,
  params: Record<string, string | number>,
) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    params?.[key] === undefined ? match : String(params[key]),
  );
}

export function isRtlEmailLocale(locale: EmailLocale): boolean {
  return locale === "ar";
}
