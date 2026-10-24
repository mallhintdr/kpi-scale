import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/AppShell';
import { Avatar, Button, Card, Field, FormError, PasswordInput, SectionTitle, useToast } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Profile() {
  const { session, setSession } = useAuth();
  const toast = useToast();
  const { user, tenant } = session!;
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const m = useMutation({
    mutationFn: () => {
      if (pw.newPassword !== pw.confirm) throw new Error('New passwords do not match');
      return post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
    },
    onSuccess: (data) => {
      setSession(data);
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      toast('Password changed. Other devices were signed out.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  return (
    <>
      <PageHeader title="Profile" back="/more" />
      <Card className="flex flex-col items-center p-6 text-center">
        <Avatar name={user.name} size={72} />
        <div className="mt-3 text-lg font-semibold">{user.name}</div>
        <div className="text-sm text-slate-500">{user.email}</div>
        <div className="mt-1 text-xs capitalize text-slate-400">{user.designation ? `${user.designation} · ` : ''}{user.role} · {tenant.name}</div>
      </Card>

      <SectionTitle>Change password</SectionTitle>
      <Card className="p-4">
        <form onSubmit={submit} className="space-y-2.5">
          <Field label="Current password">{(id) => <PasswordInput id={id} autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />}</Field>
          <Field label="New password" hint="At least 8 characters with a letter and a number">{(id) => <PasswordInput id={id} autoComplete="new-password" required minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />}</Field>
          <Field label="Confirm new password">{(id) => <PasswordInput id={id} autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />}</Field>
          <FormError error={m.error} />
          <Button type="submit" block loading={m.isPending}>Update password</Button>
        </form>
      </Card>
    </>
  );
}
