export default function CheckoutSuccessPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="max-w-md w-full space-y-5">
        <div className="text-5xl">🎉</div>
        <h1 className="text-3xl font-bold text-gray-900">You&apos;re in!</h1>
        <p className="text-gray-600 text-lg">
          Your 7-day free trial has started. Check your texts — your training plan is on its way.
        </p>
        <p className="text-gray-400 text-sm">
          You can close this window and get back to running.
        </p>
      </div>
    </div>
  );
}
