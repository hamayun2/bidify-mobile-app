import { useState, useEffect } from 'react';

const emptyCountdown = {
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
  isEnded: false,
};

const useCountdown = (endTime) => {
  const [timeLeft, setTimeLeft] = useState(emptyCountdown);

  useEffect(() => {
    const calculateTimeLeft = () => {
      if (endTime == null || endTime === '') {
        setTimeLeft(emptyCountdown);
        return;
      }

      const end = new Date(endTime);
      if (Number.isNaN(end.getTime())) {
        setTimeLeft(emptyCountdown);
        return;
      }

      const difference = end.getTime() - Date.now();

      if (difference > 0) {
        setTimeLeft({
          days: Math.floor(difference / (1000 * 60 * 60 * 24)),
          hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
          minutes: Math.floor((difference / 1000 / 60) % 60),
          seconds: Math.floor((difference / 1000) % 60),
          isEnded: false,
        });
      } else {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, isEnded: true });
      }
    };

    calculateTimeLeft();

    const timer = setInterval(calculateTimeLeft, 1000);

    return () => clearInterval(timer);
  }, [endTime]);

  return timeLeft;
};
export default useCountdown;
