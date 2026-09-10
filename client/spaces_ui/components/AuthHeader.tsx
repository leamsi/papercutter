export function AuthHeader({ logo }: { logo: string }) {
  return (
    <header class="sb-auth-header">
      <div class="sb-auth-brand">
        <img src={logo} alt="" />
        <span>SilverBullet</span>
      </div>
      <span class="sb-auth-host">{location.host}</span>
    </header>
  );
}
