export const metadata = {
  title: 'Artvision Bot',
  description: 'Telegram bot for Artvision',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
