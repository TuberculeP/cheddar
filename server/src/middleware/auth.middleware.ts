import { Request, Response, NextFunction } from "express";

export const isAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }
  // Catches accounts deactivated after the session was created.
  if (!req.user?.isActive) {
    res.status(401).json({ message: "Account is deactivated" });
    return;
  }
  next();
};
