import nodemailer from 'nodemailer';

export function createTransporter(email, appPassword) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: email,
      pass: appPassword,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    rateDelta: 2000,
    rateLimit: 5,
  });
}

export async function testConnection(email, appPassword) {
  try {
    const transporter = createTransporter(email, appPassword);
    await transporter.verify();
    transporter.close();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function sendEmail(account, mailOptions) {
  try {
    const transporter = createTransporter(account.email, account.appPassword);
    const info = await transporter.sendMail({
      from: `${account.displayName || account.email} <${account.email}>`,
      to: mailOptions.to,
      subject: mailOptions.subject,
      html: mailOptions.html,
      text: mailOptions.text,
      replyTo: mailOptions.replyTo || account.email,
    });
    transporter.close();
    return { success: true, messageId: info.messageId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
