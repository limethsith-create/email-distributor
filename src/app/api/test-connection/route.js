import { testConnection } from '@/lib/mailer';

export async function POST(request) {
  try {
    const { email, appPassword } = await request.json();

    if (!email || !appPassword) {
      return Response.json(
        { success: false, error: 'Email and app password are required' },
        { status: 400 }
      );
    }

    const result = await testConnection(email, appPassword);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
