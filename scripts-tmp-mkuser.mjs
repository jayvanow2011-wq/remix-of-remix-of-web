import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.auth.admin.createUser({
  email: 'jayjay@veltrix.xyz',
  password: 'jayjay100!',
  email_confirm: true,
  user_metadata: { username: 'jayjay', full_name: 'jayjay' }
});
console.log(JSON.stringify({ data, error }, null, 2));
